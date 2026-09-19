/**
 * Whether the hostname looks like a preview-proxy host, i.e. the dev port is
 * the first label and the rest resolves to loopback (`localhost`,
 * `vibe-kanban.localhost` behind a TLS-terminating reverse proxy, …).
 */
function hasProxyLocalhostSuffix(url: URL): boolean {
  const hostnameParts = url.hostname.split('.');
  if (hostnameParts.length < 2) return false;
  // Match on the label boundary: `.localhost` is reserved for loopback, but
  // `notlocalhost` is just some other host we must not rewrite to localhost.
  const suffix = hostnameParts.slice(1).join('.');
  return suffix === 'localhost' || suffix.endsWith('.localhost');
}

export function getTargetDevPort(
  url: URL,
  previewProxyPort?: number,
  remotePreviewSuffix?: string
): string {
  const hostnameParts = url.hostname.split('.');
  // No explicit port means the proxy is fronted on a default port (e.g. Caddy
  // terminating TLS for `*.vibe-kanban.localhost`), so it still is a proxy URL.
  const hasLocalhostSuffix =
    hasProxyLocalhostSuffix(url) &&
    (!previewProxyPort || !url.port || url.port === String(previewProxyPort));
  const hasRemotePreviewSuffix = Boolean(
    remotePreviewSuffix &&
      url.hostname.endsWith(`.${remotePreviewSuffix.replace(/^\./, '')}`)
  );

  if (hasLocalhostSuffix || hasRemotePreviewSuffix) {
    const tokenPort = hostnameParts[0]?.split('--')[0];
    if (tokenPort && /^\d+$/.test(tokenPort)) {
      return tokenPort;
    }
  }

  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

/**
 * Transform a proxy URL back to the dev server URL.
 * Proxy format: http://{devPort}.localhost:{proxyPort}{path}?_refresh=...
 * Dev format:   http://localhost:{devPort}{path}
 */
export function transformProxyUrlToDevUrl(
  proxyUrl: string,
  devPort: string
): string | null {
  try {
    const url = new URL(proxyUrl);

    if (!hasProxyLocalhostSuffix(url)) {
      return null;
    }

    url.searchParams.delete('_refresh');

    const devUrl = new URL(`http://localhost${url.pathname}`);

    const search = url.searchParams.toString();
    if (search) {
      devUrl.search = search;
    }

    if (url.hash) {
      devUrl.hash = url.hash;
    }

    if (devPort !== '80') {
      devUrl.port = devPort;
    }

    return devUrl.toString();
  } catch {
    return null;
  }
}
