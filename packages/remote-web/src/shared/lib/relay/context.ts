import {
  type PairedRelayHost,
  listPairedRelayHosts,
  resolveSigningKey,
  savePairedRelayHost,
  subscribeRelayPairingChanges,
} from "@/shared/lib/relayPairingStorage";
import {
  createRemoteSession,
  refreshRelaySigningSession,
} from "@/shared/lib/relayBackendApi";
import { buildRelaySigningSessionRefreshPayload } from "@/shared/lib/relaySigningSessionRefresh";

import type { RelayHostContext } from "@remote/shared/lib/relay/types";

const remoteSessionIdCache = new Map<string, string>();

subscribeRelayPairingChanges(({ hostId }) => {
  remoteSessionIdCache.delete(hostId);
});

export async function resolveRemoteHostContext(
  hostId: string,
): Promise<RelayHostContext> {
  const pairedHost = await findPairedHost(hostId);
  if (!pairedHost) {
    throw new Error(
      "This host is not paired with your browser. Pair it in Relay settings.",
    );
  }

  if (!pairedHost.signing_session_id) {
    throw new Error(
      "This host pairing is outdated. Re-pair it in Relay settings.",
    );
  }

  const browserSessionId = await getRemoteSessionId(hostId);
  return {
    pairedHost,
    sessionId: browserSessionId,
  };
}

export function invalidateRemoteSessionId(hostId: string): void {
  remoteSessionIdCache.delete(hostId);
}

/**
 * Drop every cached relay tunnel session id. Called on PWA resume: a relay
 * session created before the app was suspended may be dead on the cloud side,
 * so the next request re-creates a fresh one (and re-registers the signing
 * session through it) instead of reusing a stale id that 401s.
 */
export function invalidateAllRemoteSessionIds(): void {
  remoteSessionIdCache.clear();
}

// In-flight signing-session refresh per host. Entering a workspace fires ~6
// host requests at once; on an expired session they all 401 and would each kick
// off an independent refresh — wasteful and liable to trip the host's 30/min
// refresh rate limit, after which every refresh fails and the app spins. Share
// one refresh per host so the burst collapses to a single network round-trip.
const inFlightRefreshByHost = new Map<
  string,
  Promise<PairedRelayHost | null>
>();

export async function tryRefreshRelayHostSigningSession(
  context: RelayHostContext,
): Promise<RelayHostContext | null> {
  const hostId = context.pairedHost.host_id;

  let pending = inFlightRefreshByHost.get(hostId);
  if (!pending) {
    pending = refreshSigningSessionForHost(context).finally(() => {
      inFlightRefreshByHost.delete(hostId);
    });
    inFlightRefreshByHost.set(hostId, pending);
  }

  const refreshedPairedHost = await pending;
  if (!refreshedPairedHost) {
    return null;
  }

  // Share the refreshed signing session across every concurrent caller while
  // preserving each caller's own relay session id.
  return {
    ...context,
    pairedHost: { ...context.pairedHost, ...refreshedPairedHost },
  };
}

async function refreshSigningSessionForHost(
  context: RelayHostContext,
): Promise<PairedRelayHost | null> {
  const { pairedHost, sessionId } = context;
  const clientId = pairedHost.client_id;
  if (!clientId) {
    // Pairings created before client_id was persisted can never refresh (the
    // host identifies the client by client_id). This is unrecoverable without a
    // re-pair, so surface it clearly instead of failing silently.
    console.warn(
      "[relay] cannot refresh signing session: paired host has no client_id; re-pairing required",
      { hostId: pairedHost.host_id },
    );
    return null;
  }

  try {
    const signingKey = await resolveSigningKey(pairedHost);
    const payload = await buildRelaySigningSessionRefreshPayload(
      clientId,
      signingKey,
    );
    const refreshed = await refreshRelaySigningSession(
      pairedHost.host_id,
      sessionId,
      payload,
    );
    // Persist the refreshed session, and for legacy pairings migrate the
    // extractable JWK to the non-extractable CryptoKey at the same time so the
    // raw key material never lingers in IndexedDB.
    const updatedPairedHost: PairedRelayHost = {
      ...pairedHost,
      private_key: pairedHost.private_key ?? signingKey,
      signing_session_id: refreshed.signing_session_id,
    };
    delete updatedPairedHost.private_key_jwk;
    await savePairedRelayHost(updatedPairedHost);
    return updatedPairedHost;
  } catch (error) {
    console.warn("[relay] failed to refresh signing session", {
      hostId: pairedHost.host_id,
      error,
    });
    return null;
  }
}

/**
 * Proactively refresh the active host's signing session on PWA resume.
 *
 * The host's signing session has a 15-min idle TTL and lives only in host
 * memory, so a suspended PWA wakes up with an expired session. Refreshing it
 * before the next relayed request avoids the first wave of 401s entirely (the
 * WebRTC offer included), so the data channel rebuilds on the first try instead
 * of bouncing off an auth failure. Best-effort: failures are logged and the
 * caller proceeds to rebuild the connection regardless.
 */
export async function refreshActiveHostSigningSessionForResume(
  hostId: string,
): Promise<void> {
  try {
    const context = await resolveRemoteHostContext(hostId);
    await tryRefreshRelayHostSigningSession(context);
  } catch (error) {
    console.warn("[relay] resume signing-session refresh skipped", {
      hostId,
      error,
    });
  }
}

async function getRemoteSessionId(hostId: string): Promise<string> {
  const cached = remoteSessionIdCache.get(hostId);
  if (cached) {
    return cached;
  }

  const resp = await createRemoteSession(hostId).catch((error) => {
    remoteSessionIdCache.delete(hostId);
    throw error;
  });

  remoteSessionIdCache.set(hostId, resp.session_id);
  return resp.session_id;
}

async function findPairedHost(hostId: string): Promise<PairedRelayHost | null> {
  const pairedHosts = await listPairedRelayHosts();
  return pairedHosts.find((host) => host.host_id === hostId) ?? null;
}
