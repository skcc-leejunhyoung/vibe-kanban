import type {
  RelayHost,
  StartAccountSessionResponse,
} from 'shared/remote-types';
import type { RelayHostContext } from '@/shared/lib/relay/types';
import { getAuthRuntime } from '@/shared/lib/auth/runtime';
import { getRemoteApiUrl, listRelayHosts } from '@/shared/lib/remoteApi';
import { buildRemoteSessionBaseUrl } from '@/shared/lib/relayBackendApi';
import { hostAccountApi, HostAccountError } from '@/shared/lib/hostAccountApi';
import {
  bytesToBase64,
  TEXT_ENCODER,
  toArrayBuffer,
} from '@/shared/lib/relay/bytes';

type Connection = {
  context: RelayHostContext;
  expires: number;
  timer?: ReturnType<typeof setTimeout>;
};
let identity = '';
let epoch = 0;
const connections = new Map<string, Connection>();
const pending = new Map<string, Promise<RelayHostContext>>();
let hosts:
  | { identity: string; expires: number; promise: Promise<RelayHost[]> }
  | undefined;
const cleanup = new Set<() => void>();

export function resetAccountHostConnections(): void {
  epoch++;
  identity = '';
  hosts = undefined;
  for (const connection of connections.values()) clearTimeout(connection.timer);
  connections.clear();
  pending.clear();
  for (const cancel of cleanup) cancel();
  cleanup.clear();
}

export function watchAccountConnectionCleanup(cancel: () => void): () => void {
  cleanup.add(cancel);
  return () => cleanup.delete(cancel);
}

async function currentIdentity(): Promise<string> {
  const token = await getAuthRuntime().getToken();
  if (!token) {
    resetAccountHostConnections();
    throw new HostAccountError(
      401,
      'ACCOUNT_SESSION_REVOKED',
      '다시 로그인해 주세요.'
    );
  }
  // This is a cache namespace, not authorization. The server verifies the JWT.
  const claims = JSON.parse(
    atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
  ) as { sub: string; session_id: string };
  if (!claims.sub || !claims.session_id)
    throw new Error('Invalid account session');
  const next = `${getRemoteApiUrl()}:${claims.sub}:${claims.session_id}`;
  if (identity !== next) {
    if (identity) resetAccountHostConnections();
    identity = next;
  }
  return next;
}

export async function accountHost(hostId: string): Promise<RelayHost | null> {
  const owner = await currentIdentity();
  if (!hosts || hosts.identity !== owner || hosts.expires < Date.now()) {
    const promise = listRelayHosts();
    hosts = { identity: owner, expires: Date.now() + 30_000, promise };
    void promise.catch(() => {
      if (hosts?.promise === promise) hosts = undefined;
    });
  }
  const rows = await hosts.promise;
  if ((await currentIdentity()) !== owner)
    throw new Error('Account changed during host lookup');
  const host = rows.find((host) => host.id === hostId);
  if (!host)
    throw new HostAccountError(
      403,
      'HOST_ACCESS_REVOKED',
      '이 호스트에 접근할 권한이 없습니다.'
    );
  if (host.auth_mode === 'migrating')
    throw new HostAccountError(
      409,
      'HOST_TRANSITION_IN_PROGRESS',
      '호스트 연결을 확인하고 있습니다. 잠시 후 다시 시도해 주세요.'
    );
  return host.auth_mode === 'account' ? host : null;
}

export async function resolveAccountHostConnection(
  hostId: string,
  refresh = false
): Promise<RelayHostContext> {
  const owner = await currentIdentity();
  const currentEpoch = epoch;
  const key = `${owner}:${hostId}`;
  const cached = connections.get(key);
  if (!refresh && cached && cached.expires > Date.now() + 60_000)
    return cached.context;
  const active = pending.get(key);
  if (active) return active;
  const opening = (async () => {
    const host = await accountHost(hostId);
    if (!host || !host.remote_access_enabled)
      throw new HostAccountError(
        403,
        'HOST_ACCESS_REVOKED',
        '이 호스트에 접근할 권한이 없거나 원격 접속이 중지되었습니다.'
      );
    const pair = cached?.context.pairedHost;
    let keyPair: CryptoKeyPair | null = null;
    if (!pair) {
      try {
        keyPair = (await crypto.subtle.generateKey('Ed25519', false, [
          'sign',
          'verify',
        ])) as CryptoKeyPair;
      } catch {
        throw new HostAccountError(
          409,
          'HOST_BROWSER_UPDATE_REQUIRED',
          '이 브라우저는 안전한 호스트 접속에 필요한 암호 기능을 지원하지 않습니다. 최신 브라우저의 HTTPS 주소에서 다시 열어 주세요.'
        );
      }
    }
    const privateKey = pair?.private_key ?? keyPair!.privateKey;
    const publicKey =
      pair?.public_key_b64 ??
      bytesToBase64(
        new Uint8Array(await crypto.subtle.exportKey('raw', keyPair!.publicKey))
      );
    let approval;
    try {
      approval = await hostAccountApi.open(hostId, {
        public_key_b64: publicKey,
        connection_id: cached?.context.sessionId ?? null,
      });
    } catch (error) {
      if (
        !(error instanceof HostAccountError) ||
        error.code !== 'HOST_CONNECTION_EXPIRED' ||
        !cached
      )
        throw error;
      // A revoked connection ID is never revived. Opening a new connection
      // still performs fresh central authorization and does not replay a write.
      clearTimeout(cached.timer);
      connections.delete(key);
      approval = await hostAccountApi.open(hostId, {
        public_key_b64: publicKey,
        connection_id: null,
      });
    }
    if (epoch !== currentEpoch || (await currentIdentity()) !== owner)
      throw new Error('Account changed during connection approval');
    const proof = await crypto.subtle.sign(
      'Ed25519',
      privateKey!,
      toArrayBuffer(
        TEXT_ENCODER.encode(`vk-host-account-session-v1\n${approval.grant}`)
      )
    );
    const response = await fetch(
      `${buildRemoteSessionBaseUrl(hostId, approval.connection_id)}/api/relay-auth/account/session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({
          grant: approval.grant,
          proof_b64: bytesToBase64(new Uint8Array(proof)),
        }),
      }
    );
    if (!response.ok)
      throw new HostAccountError(
        response.status,
        response.status === 403
          ? 'HOST_ACCESS_REVOKED'
          : 'HOST_CONNECTION_EXPIRED',
        response.status === 503 || response.status === 404
          ? '호스트가 오프라인입니다.'
          : '호스트 연결을 다시 확인해 주세요.'
      );
    const result = (await response.json()) as {
      data: StartAccountSessionResponse;
    };
    if (epoch !== currentEpoch || (await currentIdentity()) !== owner)
      throw new Error('Account changed during host connection');
    const context: RelayHostContext = {
      sessionId: approval.connection_id,
      pairedHost: {
        host_id: hostId,
        host_name: host.name,
        account_ephemeral: true,
        private_key: privateKey!,
        public_key_b64: publicKey,
        signing_session_id: result.data.signing_session_id,
        server_public_key_b64: result.data.server_public_key_b64,
        paired_at: new Date().toISOString(),
      },
    };
    clearTimeout(cached?.timer);
    const connection: Connection = {
      context,
      expires: Date.parse(approval.expires_at),
    };
    connections.set(key, connection);
    // Refresh even when only long-lived streams are active. Network failures
    // preserve the login; bounded retries stop when the account changes.
    const schedule = (attempt: number) => {
      connection.timer = setTimeout(
        () => {
          if (epoch !== currentEpoch || connections.get(key) !== connection)
            return;
          void resolveAccountHostConnection(hostId, true).catch(
            (error: unknown) => {
              if (
                error instanceof HostAccountError &&
                (error.status === 401 || error.status === 403)
              ) {
                connections.delete(key);
                return;
              }
              schedule(Math.min(attempt + 1, 5));
            }
          );
        },
        attempt === -1
          ? Math.max(1000, connection.expires - Date.now() - 60_000)
          : Math.min(30_000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4)
      );
    };
    schedule(-1);
    return context;
  })();
  pending.set(key, opening);
  try {
    return await opening;
  } catch (error) {
    if (
      error instanceof HostAccountError &&
      (error.status === 401 || error.status === 403)
    ) {
      clearTimeout(connections.get(key)?.timer);
      connections.delete(key);
      hosts = undefined;
    }
    throw error;
  } finally {
    if (pending.get(key) === opening) pending.delete(key);
  }
}

if (typeof window !== 'undefined') {
  const resume = () => {
    hosts = undefined;
    for (const connection of connections.values()) {
      void resolveAccountHostConnection(
        connection.context.pairedHost.host_id,
        true
      ).catch(() => {});
    }
  };
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
  });
}
