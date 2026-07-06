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
 */
export function openExternalUrl(url: string): void {
  const opened = window.open(url, '_blank');
  if (opened) {
    opened.opener = null;
  }
}
