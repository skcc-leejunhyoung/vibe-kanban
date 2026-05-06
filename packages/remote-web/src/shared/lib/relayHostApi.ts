import {
  invalidateRemoteSessionId,
  resolveRemoteHostContext,
  tryRefreshRelayHostSigningSession,
} from "@remote/shared/lib/relay/context";
import { getActiveRelayHostId } from "@remote/shared/lib/relay/activeHostContext";
import {
  isAuthFailureStatus,
  sendRelayHostRequest,
} from "@remote/shared/lib/relay/http";
import {
  isWorkspaceRoutePath,
  normalizePath,
  openBrowserWebSocket,
  resolveRelayHostIdForCurrentPage,
  shouldRelayApiPath,
  toPathAndQuery,
} from "@remote/shared/lib/relay/routing";
import {
  appendSignatureToPath,
  buildRelaySignature,
  normalizeRequestBody,
} from "@remote/shared/lib/relay/signing";
import {
  createRelaySignedWebSocket,
  createRelayWsSigningContext,
} from "@remote/shared/lib/relay/ws";
import { buildRemoteSessionBaseUrl } from "@/shared/lib/relayBackendApi";
import type {
  LocalApiRequestOptions,
  LocalApiWebSocketOptions,
} from "@/shared/lib/localApiTransport";

const EMPTY_BYTES = new Uint8Array();

// `localApiTransport.scopeLocalApiPath` rewrites relative `/api/*` paths to
// `/api/host/{hostId}/*` so that a single relay-tunnel session can address
// arbitrary paired hosts. The relay tunnel path itself already pins the
// destination host (via the `/v1/relay/h/{hostId}/...` segment), and the host
// that receives the proxied request would otherwise loop the call through
// `host_relay::proxy` for a host_id it doesn't have credentials for. Strip
// the prefix so the host's main router handles the request directly.
function unscopeHostApiPath(pathAndQuery: string, hostId: string): string {
  const prefix = `/api/host/${hostId}`;
  if (
    pathAndQuery === prefix ||
    pathAndQuery.startsWith(`${prefix}/`) ||
    pathAndQuery.startsWith(`${prefix}?`)
  ) {
    return `/api${pathAndQuery.slice(prefix.length)}`;
  }
  return pathAndQuery;
}

export { isWorkspaceRoutePath };

export async function requestLocalApiViaRelay(
  pathOrUrl: string,
  requestInit: LocalApiRequestOptions = {},
): Promise<Response> {
  const pathAndQuery = toPathAndQuery(pathOrUrl);
  const {
    relayHostId,
    hostId: _hostId,
    hostScope: _hostScope,
    ...relayRequestInit
  } = requestInit;

  if (!shouldRelayApiPath(pathAndQuery)) {
    return fetch(pathOrUrl, relayRequestInit);
  }

  const hostId =
    relayHostId ?? resolveRelayHostIdForCurrentPage() ?? getActiveRelayHostId();
  if (!hostId) {
    throw new Error(
      "Host context is required for local API requests. Navigate under /hosts/{hostId}/...",
    );
  }

  return requestRelayHostApi(
    hostId,
    unscopeHostApiPath(pathAndQuery, hostId),
    relayRequestInit,
  );
}

export async function openLocalApiWebSocketViaRelay(
  pathOrUrl: string,
  options: LocalApiWebSocketOptions = {},
): Promise<WebSocket> {
  const pathAndQuery = toPathAndQuery(pathOrUrl);

  if (!shouldRelayApiPath(pathAndQuery)) {
    return openBrowserWebSocket(pathOrUrl);
  }

  const hostId =
    options.relayHostId ??
    resolveRelayHostIdForCurrentPage() ??
    getActiveRelayHostId();
  if (!hostId) {
    throw new Error(
      "Host context is required for local API WebSocket requests. Navigate under /hosts/{hostId}/...",
    );
  }

  return openRelayHostWebSocket(hostId, unscopeHostApiPath(pathAndQuery, hostId));
}

export async function requestRelayHostApi(
  hostId: string,
  pathOrUrl: string,
  requestInit: RequestInit = {},
): Promise<Response> {
  const pathAndQuery = toPathAndQuery(pathOrUrl);
  const normalizedPath = normalizePath(pathAndQuery);
  const method = (requestInit.method ?? "GET").toUpperCase();

  const { body, bodyBytes, contentType } = await normalizeRequestBody(
    requestInit.body,
  );

  const context = await resolveRemoteHostContext(hostId);
  const initialResponse = await sendRelayHostRequest(context, {
    normalizedPath,
    method,
    body,
    bodyBytes,
    contentType,
    requestInit,
  });
  if (!isAuthFailureStatus(initialResponse.status)) {
    return initialResponse;
  }

  invalidateRemoteSessionId(hostId);
  const refreshedContext = await tryRefreshRelayHostSigningSession(context);
  if (!refreshedContext) {
    return initialResponse;
  }

  const retryResponse = await sendRelayHostRequest(refreshedContext, {
    normalizedPath,
    method,
    body,
    bodyBytes,
    contentType,
    requestInit,
  });
  if (isAuthFailureStatus(retryResponse.status)) {
    invalidateRemoteSessionId(hostId);
  }

  return retryResponse;
}

export async function openRelayHostWebSocket(
  hostId: string,
  pathOrUrl: string,
): Promise<WebSocket> {
  const baseContext = await resolveRemoteHostContext(hostId);
  const context =
    (await tryRefreshRelayHostSigningSession(baseContext)) ?? baseContext;
  const pathAndQuery = toPathAndQuery(pathOrUrl);
  const normalizedPath = normalizePath(pathAndQuery);

  const signature = await buildRelaySignature(
    context.pairedHost,
    "GET",
    normalizedPath,
    EMPTY_BYTES,
  );
  const base_url = buildRemoteSessionBaseUrl(
    context.pairedHost.host_id,
    context.sessionId,
  );

  const signedPath = appendSignatureToPath(normalizedPath, signature);
  const wsUrl = `${base_url}${signedPath}`.replace(/^http/i, "ws");

  const signingContext = await createRelayWsSigningContext(
    context.pairedHost,
    signature,
  );
  return createRelaySignedWebSocket(new WebSocket(wsUrl), signingContext);
}
