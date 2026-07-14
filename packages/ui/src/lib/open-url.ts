/**
 * Opens an external URL in a new window.
 *
 * In an installed PWA (macOS standalone display mode) a plain
 * `<a target="_blank">` navigation is handed off to the system default
 * browser, whereas `window.open(url, '_blank')` (with no feature string)
 * opens a new window inside the PWA context. Use this everywhere so external
 * links open consistently in the PWA window instead of Safari/Chrome.
 *
 * The `opener` reference is nulled afterwards for the same security guarantee
 * as `rel="noopener"` — note this is done on the returned handle rather than
 * via the feature string, since passing `noopener` there re-triggers the
 * default-browser hand-off in some PWA builds.
 *
 * Only http(s) URLs are opened. Unlike a plain `<a href>` (which the browser
 * renders inertly for unusual schemes), `window.open('javascript:…')` executes
 * in this origin and `data:`/`blob:` open attacker-controlled content in the
 * PWA context, so the scheme is validated first.
 */
/** Reserve a popup during a user gesture for navigation after async work. */
export function reserveExternalWindow(): Window | null {
  const opened = window.open('', '_blank');
  if (opened) {
    opened.opener = null;
  }
  return opened;
}

export function openExternalUrl(url: string, opened?: Window | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }

  if (opened) {
    opened.location.href = parsed.href;
    return true;
  }

  const newWindow = window.open(parsed.href, '_blank');
  if (newWindow) {
    newWindow.opener = null;
  }
  return newWindow !== null;
}
