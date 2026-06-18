import { useState, useSyncExternalStore } from 'react';
import { isRealMobileDevice } from '@vibe/ui/lib/platform';

const MOBILE_BREAKPOINT = 767;
const query = `(max-width: ${MOBILE_BREAKPOINT}px)`;
let mediaQuery: MediaQueryList | null = null;

function getMediaQuery() {
  if (!mediaQuery) {
    mediaQuery = window.matchMedia(query);
  }
  return mediaQuery;
}

function subscribe(callback: () => void) {
  const mq = getMediaQuery();
  mq.addEventListener('change', callback);
  return () => mq.removeEventListener('change', callback);
}

function getSnapshot() {
  return getMediaQuery().matches;
}

/**
 * Returns true when the viewport is at or below mobile breakpoint (767px).
 * Uses a singleton MediaQueryList for efficient re-renders.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Raw check without React hook — for use in store actions */
export function isMobileViewport(): boolean {
  return window.matchMedia(query).matches;
}

// Canonical implementation lives in @vibe/ui/lib/platform; re-exported here so
// existing consumers can keep importing it from this module.
export { isRealMobileDevice };

/** React hook version of isRealMobileDevice — stable, no re-renders on resize */
export function useIsRealMobile(): boolean {
  // Device type doesn't change during session, so compute once
  const [isReal] = useState(() => isRealMobileDevice());
  return isReal;
}
