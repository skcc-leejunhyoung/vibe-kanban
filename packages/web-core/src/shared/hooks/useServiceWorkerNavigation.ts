import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';

/**
 * Navigate client-side when the service worker asks us to.
 *
 * When a web push notification is clicked while the app (PWA) is already open,
 * iOS standalone PWAs cannot reliably navigate an existing window from the
 * service worker (`client.navigate` is a no-op). Instead `sw.js` focuses the
 * window and posts a `{ type: 'vk-navigate', path }` message, which we handle
 * here via the router so the deep-link works on every platform.
 */
export function useServiceWorkerNavigation() {
  const navigate = useNavigate();

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    const handler = (event: MessageEvent) => {
      const data = event.data as
        | { type?: string; path?: string }
        | undefined;
      if (
        !data ||
        data.type !== 'vk-navigate' ||
        typeof data.path !== 'string' ||
        !data.path.startsWith('/')
      ) {
        return;
      }
      void navigate({ to: data.path as '/', replace: false });
    };

    navigator.serviceWorker.addEventListener('message', handler);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handler);
    };
  }, [navigate]);
}
