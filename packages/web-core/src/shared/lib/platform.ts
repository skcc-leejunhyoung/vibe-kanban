export function isMac(): boolean {
  // Modern API (Chrome, Edge) - not supported in Safari
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  if (nav.userAgentData?.platform) {
    return nav.userAgentData.platform === 'macOS';
  }
  // Fallback for Safari and older browsers
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function getModifierKey(): string {
  return isMac() ? '⌘' : 'Ctrl';
}

export function isTauriApp(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

// Installed PWA (macOS Safari Dock web app, iOS home-screen app, Chrome
// installed app) — running as its own window rather than a browser tab.
export function isStandalonePwa(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    nav.standalone === true
  );
}

export function isTauriMac(): boolean {
  return isTauriApp() && isMac();
}
