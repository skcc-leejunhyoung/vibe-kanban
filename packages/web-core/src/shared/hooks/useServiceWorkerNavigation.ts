import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  isSplitScreenEmbed,
  SPLIT_PANE_SERVICE_WORKER_NAVIGATION_EVENT,
} from '@/shared/components/SplitScreenSurface';
import {
  shouldRenderSplitScreenFrames,
  type SplitPreset,
  useSplitScreenStore,
} from '@/shared/stores/useSplitScreenStore';

export function getServiceWorkerNavigationTarget(
  isEmbedded: boolean,
  preset: SplitPreset
): 'parent' | 'active-pane' | 'router' {
  if (isEmbedded) return 'parent';
  return shouldRenderSplitScreenFrames(preset) ? 'active-pane' : 'router';
}

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
      const data = event.data as { type?: string; path?: string } | undefined;
      if (
        !data ||
        data.type !== 'vk-navigate' ||
        typeof data.path !== 'string' ||
        !data.path.startsWith('/')
      ) {
        return;
      }

      // Every split pane is a controlled service-worker client. Relay a
      // notification received by any iframe to its parent so it can choose the
      // last active pane, rather than letting the arbitrary receiving iframe
      // navigate itself.
      const target = getServiceWorkerNavigationTarget(
        isSplitScreenEmbed(),
        useSplitScreenStore.getState().preset
      );

      if (target === 'parent') {
        window.parent.postMessage(
          {
            type: 'vk-split-pane',
            event: 'service-worker-navigate',
            url: data.path,
          },
          window.location.origin
        );
        return;
      }

      if (target === 'active-pane') {
        window.dispatchEvent(
          new CustomEvent(SPLIT_PANE_SERVICE_WORKER_NAVIGATION_EVENT, {
            detail: { url: data.path },
          })
        );
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
