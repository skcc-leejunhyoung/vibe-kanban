export function getTargetDevPort(
  url: URL,
  previewProxyPort?: number,
  remotePreviewSuffix?: string
): string {
  const hostnameParts = url.hostname.split('.');
  const hasLocalhostSuffix =
    hostnameParts.length >= 2 &&
    hostnameParts.slice(1).join('.').startsWith('localhost');
  const hasRemotePreviewSuffix = Boolean(
    remotePreviewSuffix &&
      url.hostname.endsWith(`.${remotePreviewSuffix.replace(/^\./, '')}`)
  );

  if (
    (hasLocalhostSuffix &&
      (!previewProxyPort || url.port === String(previewProxyPort))) ||
    hasRemotePreviewSuffix
  ) {
    const tokenPort = hostnameParts[0]?.split('--')[0];
    if (tokenPort && /^\d+$/.test(tokenPort)) {
      return tokenPort;
    }
  }

  return url.port || (url.protocol === 'https:' ? '443' : '80');
}
