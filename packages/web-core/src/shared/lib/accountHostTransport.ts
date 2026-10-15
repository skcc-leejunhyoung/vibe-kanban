import {
  accountHost,
  resolveAccountHostConnection,
  watchAccountConnectionCleanup,
} from '@/shared/lib/accountHostConnection';
import { buildRemoteSessionBaseUrl } from '@/shared/lib/relayBackendApi';
import {
  appendSignatureToPath,
  buildRelaySignature,
  normalizeRequestBody,
} from '@/shared/lib/relay/signing';
import { sendRelayHostRequest } from '@/shared/lib/relay/http';
import { queryClient } from '@/shared/lib/queryClient';
import { HostAccountError } from '@/shared/lib/hostAccountApi';
import {
  createRelaySignedWebSocket,
  createRelayWsSigningContext,
} from '@/shared/lib/relay/ws';

let selfHost: Promise<string | null> | undefined;

export function resetLocalSelfHost(): void {
  selfHost = undefined;
}

export async function isLocalSelfHost(host: string): Promise<boolean> {
  selfHost ??= fetch('/api/relay-auth/client/self-host')
    .then(async (response) => {
      if (!response.ok) throw new Error('Local host unavailable');
      return (await response.json()).data.host_id as string | null;
    })
    .catch(() => {
      selfHost = undefined;
      return null;
    });
  return (await selfHost) === host;
}

// Local A -> B uses B's approval for the browser's current account. No hop
// through A can accidentally borrow A's owner's saved B pairing/credentials.
export async function resolveLocalAccountTarget(
  path: string
): Promise<{ host: string; path: string } | null> {
  const match = /^\/api\/host\/([^/]+)(\/.*)$/.exec(path);
  if (!match) return null;
  if (await isLocalSelfHost(match[1])) return null;
  if (!(await accountHost(match[1]))) return null;
  return { host: match[1], path: `/api${match[2]}` };
}

export async function requestAccountHost(
  hostId: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  let context = await resolveAccountHostConnection(hostId);
  const method = (init.method ?? 'GET').toUpperCase();
  const abort = new AbortController();
  const remove = watchAccountConnectionCleanup(() => abort.abort());
  const requestInit = {
    ...init,
    signal: init.signal
      ? AbortSignal.any([init.signal, abort.signal])
      : abort.signal,
  };
  let streaming = false;
  let sent = false;
  try {
    const body = await normalizeRequestBody(init.body);
    requestInit.signal.throwIfAborted();
    sent = true;
    let response = await sendRelayHostRequest(context, {
      ...body,
      normalizedPath: path,
      method,
      requestInit,
    });
    // A mutation with an unknown result must never be sent a second time.
    if (response.status === 401 && (method === 'GET' || method === 'HEAD')) {
      context = await resolveAccountHostConnection(hostId, true);
      response = await sendRelayHostRequest(context, {
        ...body,
        normalizedPath: path,
        method,
        requestInit,
      });
    }
    requestInit.signal.throwIfAborted();
    if (response.status >= 500 && !['GET', 'HEAD'].includes(method))
      throw new Error('Host response unavailable');
    if (!response.body) return response;
    const reader = response.body.getReader();
    streaming = true;
    const bodyStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            remove();
            controller.close();
          } else controller.enqueue(result.value);
        } catch (error) {
          remove();
          controller.error(error);
        }
      },
      async cancel(reason) {
        remove();
        await reader.cancel(reason);
      },
    });
    return new Response(bodyStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (
      sent &&
      !['GET', 'HEAD'].includes(method) &&
      !requestInit.signal.aborted
    ) {
      // Reconcile by reading state; never replay a command whose result is lost.
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes(hostId),
      });
      throw new HostAccountError(
        502,
        'HOST_WRITE_OUTCOME_UNKNOWN',
        '요청 결과를 확인하지 못해 상태를 다시 조회하고 있습니다. 실행 여부를 확인한 뒤 다시 시도하세요.'
      );
    }
    throw error;
  } finally {
    if (!streaming) remove();
  }
}

export async function openAccountHostWebSocket(
  hostId: string,
  path: string
): Promise<WebSocket> {
  const context = await resolveAccountHostConnection(hostId);
  let socket: WebSocket | undefined;
  let cancelled = false;
  const remove = watchAccountConnectionCleanup(() => {
    cancelled = true;
    socket?.close();
  });
  try {
    const signature = await buildRelaySignature(
      context.pairedHost,
      'GET',
      path,
      new Uint8Array()
    );
    const url =
      `${buildRemoteSessionBaseUrl(hostId, context.sessionId)}${appendSignatureToPath(path, signature)}`.replace(
        /^http/i,
        'ws'
      );
    const signing = await createRelayWsSigningContext(
      context.pairedHost,
      signature
    );
    if (cancelled) throw new DOMException('Account changed', 'AbortError');
    socket = createRelaySignedWebSocket(new WebSocket(url), signing);
    socket.addEventListener('close', remove, { once: true });
    return socket;
  } catch (error) {
    remove();
    throw error;
  }
}
