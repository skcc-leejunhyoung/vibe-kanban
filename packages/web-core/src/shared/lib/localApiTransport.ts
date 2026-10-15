import { getCurrentHostId } from '@/shared/providers/HostIdProvider';
import {
  openSseAsWebSocket,
  shouldUseSseStream,
  toSseUrl,
} from '@/shared/lib/sseStream';

export type LocalApiHostScope = 'current' | 'explicit' | 'none';

export interface LocalApiRequestOptions extends RequestInit {
  hostScope?: LocalApiHostScope;
  hostId?: string | null;
  relayHostId?: string | null;
}

export interface LocalApiWebSocketOptions {
  hostScope?: LocalApiHostScope;
  hostId?: string | null;
  relayHostId?: string | null;
}

export interface LocalApiTransport {
  request: (
    pathOrUrl: string,
    init?: LocalApiRequestOptions
  ) => Promise<Response>;
  openWebSocket: (
    pathOrUrl: string,
    options?: LocalApiWebSocketOptions
  ) => Promise<WebSocket> | WebSocket;
  /**
   * Open a JSON-patch stream. Optional transports fall back to `openWebSocket`.
   * Implementations may select SSE to avoid opening one WebSocket per stream.
   */
  openStream?: (
    pathOrUrl: string,
    options?: LocalApiWebSocketOptions
  ) => Promise<WebSocket> | WebSocket;
}

const LOCAL_ONLY_API_PREFIXES = [
  '/api/auth/',
  '/api/open-remote-editor/',
  '/api/relay-auth/server/',
  '/api/relay-auth/client/',
  '/api/relay-auth/account/registration',
];
// Under `/api/auth/` but host-scoped: uploads the selected host's own `gh`
// login, so it must not fall back to the local machine.
const HOST_SCOPED_AUTH_PREFIX = '/api/auth/github-credential/';

function isAbsoluteUrl(pathOrUrl: string): boolean {
  return /^https?:\/\//i.test(pathOrUrl) || /^wss?:\/\//i.test(pathOrUrl);
}

function toPathAndQuery(pathOrUrl: string): string {
  if (isAbsoluteUrl(pathOrUrl)) {
    const url = new URL(pathOrUrl);
    return `${url.pathname}${url.search}`;
  }
  return pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
}

function toAbsoluteWsUrl(pathOrUrl: string): string {
  if (/^wss?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl.replace(/^http/i, 'ws');

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${protocol}//${window.location.host}${path}`;
}

function scopeLocalApiPath(pathOrUrl: string, hostId: string | null): string {
  if (!hostId) return pathOrUrl;
  const path = toPathAndQuery(pathOrUrl);
  // These endpoints must always hit the local backend because they rely on
  // local-only credentials/state.
  if (
    !path.startsWith(HOST_SCOPED_AUTH_PREFIX) &&
    LOCAL_ONLY_API_PREFIXES.some((prefix) => path.startsWith(prefix))
  ) {
    return pathOrUrl;
  }

  if (!path.startsWith('/api/') || path.startsWith('/api/host/'))
    return pathOrUrl;

  const suffix = path.slice('/api'.length);
  return `/api/host/${hostId}${suffix}`;
}

function resolveScopedPath(
  pathOrUrl: string,
  options: {
    hostScope?: LocalApiHostScope;
    hostId?: string | null;
  } = {}
): string {
  const hostScope = options.hostScope ?? 'current';

  if (hostScope === 'none') {
    return pathOrUrl;
  }

  if (hostScope === 'explicit') {
    return scopeLocalApiPath(pathOrUrl, options.hostId ?? null);
  }

  return scopeLocalApiPath(pathOrUrl, getCurrentHostId());
}

const defaultTransport: LocalApiTransport = {
  request: async (pathOrUrl, init = {}) => {
    const requestInit = { ...init };
    delete requestInit.hostScope;
    delete requestInit.hostId;
    delete requestInit.relayHostId;
    if (pathOrUrl.startsWith('/api/host/')) {
      const account = await import('@/shared/lib/accountHostTransport');
      const target = await account.resolveLocalAccountTarget(pathOrUrl);
      if (target)
        return account.requestAccountHost(
          target.host,
          target.path,
          requestInit
        );
    }
    return fetch(pathOrUrl, requestInit);
  },
  openWebSocket: async (pathOrUrl) => {
    if (pathOrUrl.startsWith('/api/host/')) {
      const account = await import('@/shared/lib/accountHostTransport');
      const target = await account.resolveLocalAccountTarget(pathOrUrl);
      if (target)
        return account.openAccountHostWebSocket(target.host, target.path);
    }
    return new WebSocket(toAbsoluteWsUrl(pathOrUrl));
  },
  openStream: async (pathOrUrl) => {
    if (pathOrUrl.startsWith('/api/host/')) {
      const account = await import('@/shared/lib/accountHostTransport');
      const target = await account.resolveLocalAccountTarget(pathOrUrl);
      if (target)
        return account.openAccountHostWebSocket(target.host, target.path);
    }
    if (shouldUseSseStream()) {
      // The SSE adapter exposes the same WebSocket-shaped surface the stream
      // consumers drive, so it's safe to present it as a WebSocket.
      return openSseAsWebSocket(toSseUrl(pathOrUrl)) as unknown as WebSocket;
    }
    return new WebSocket(toAbsoluteWsUrl(pathOrUrl));
  },
};

let transport: LocalApiTransport = defaultTransport;

export function setLocalApiTransport(nextTransport: LocalApiTransport | null) {
  transport = nextTransport ?? defaultTransport;
}

export async function makeLocalApiRequest(
  pathOrUrl: string,
  init: LocalApiRequestOptions = {}
): Promise<Response> {
  return transport.request(resolveScopedPath(pathOrUrl, init), init);
}

export async function openLocalApiWebSocket(
  pathOrUrl: string,
  options: LocalApiWebSocketOptions = {}
): Promise<WebSocket> {
  return transport.openWebSocket(
    resolveScopedPath(pathOrUrl, options),
    options
  );
}

/**
 * Open a JSON-patch stream through the active transport. Uses the transport's
 * `openStream` (local: SSE-or-WebSocket) when present, otherwise falls back to
 * `openWebSocket` when the active transport has no stream-specific path.
 */
export async function openLocalApiStream(
  pathOrUrl: string,
  options: LocalApiWebSocketOptions = {}
): Promise<WebSocket> {
  const scoped = resolveScopedPath(pathOrUrl, options);
  if (transport.openStream) {
    return transport.openStream(scoped, options);
  }
  return transport.openWebSocket(scoped, options);
}
