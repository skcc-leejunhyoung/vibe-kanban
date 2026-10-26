import { useEffect } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';

/**
 * `?drawer=<note id>` on any route (the deep link older Drawer notifications
 * and pushes carry) opens that note on the Drawer page, replacing the entry so
 * back-navigation does not reopen it. New links point at `/drawer?note=`.
 */
export function useDrawerDeepLink() {
  const location = useLocation();
  const appNavigation = useAppNavigation();
  const search = location.search as Record<string, unknown>;
  const noteId = typeof search.drawer === 'string' ? search.drawer : null;
  useEffect(() => {
    if (!noteId) return;
    appNavigation.goToDrawer(noteId, { replace: true });
    // `search` is a fresh object every render; the note id is the real key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);
}
