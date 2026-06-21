export function isMac(): boolean {
  // Modern API (Chrome, Edge) - not supported in Safari.
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  if (nav.userAgentData?.platform) {
    return nav.userAgentData.platform === 'macOS';
  }
  // Fallback for Safari and older browsers.
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function getModifierKey(): string {
  return isMac() ? '\u2318' : 'Ctrl';
}

/** Detect a real mobile device via user-agent (not just viewport width). */
export function isRealMobileDevice(): boolean {
  // Modern API: navigator.userAgentData.mobile (Chrome, Edge, Opera).
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (nav.userAgentData?.mobile !== undefined) {
    return nav.userAgentData.mobile;
  }
  // Fallback: user-agent string regex (Safari, Firefox).
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Windows Phone|Mobi/i.test(
    navigator.userAgent
  );
}

/**
 * Detect a touch-capable device. Unlike isRealMobileDevice (user-agent based),
 * this also catches iPadOS, which reports a desktop "Macintosh" user-agent in
 * Safari and PWA/standalone mode yet still exposes touch points. Desktops with a
 * mouse report maxTouchPoints === 0, so they are correctly excluded.
 */
export function isTouchDevice(): boolean {
  if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) {
    return true;
  }
  if (typeof window !== 'undefined' && 'ontouchstart' in window) {
    return true;
  }
  return false;
}

type TauriInvoke = (
  cmd: string,
  args?: Record<string, unknown>
) => Promise<unknown>;

export function getTauriInvoke(): TauriInvoke | null {
  if (typeof window === 'undefined') return null;
  const maybeInvoke = (
    window as Window & { __TAURI_INTERNALS__?: { invoke?: TauriInvoke } }
  ).__TAURI_INTERNALS__?.invoke;
  return typeof maybeInvoke === 'function' ? maybeInvoke : null;
}

export function isTauriRuntime(): boolean {
  return getTauriInvoke() !== null;
}
