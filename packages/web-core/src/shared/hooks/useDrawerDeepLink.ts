import { useEffect } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { QuickChatDialog } from '@/shared/dialogs/QuickChatDialog';

/**
 * `?drawer=<note id>` (the deep link in a Drawer notification and its push)
 * opens the Quick chat dialog on that note, then drops the parameter so a
 * reload or back-navigation does not reopen it.
 */
export function useDrawerDeepLink() {
  const location = useLocation();
  const navigate = useNavigate();
  const search = location.search as Record<string, unknown>;
  const noteId = typeof search.drawer === 'string' ? search.drawer : null;
  useEffect(() => {
    if (!noteId) return;
    void QuickChatDialog.show({ noteId });
    const { drawer: _drawer, ...rest } = search;
    void navigate({
      to: location.pathname as '/',
      search: rest as never,
      replace: true,
    });
    // `search` is a fresh object every render; the note id is the real key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);
}
