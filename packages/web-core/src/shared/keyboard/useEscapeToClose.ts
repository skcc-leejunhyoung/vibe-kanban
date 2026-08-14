import { useHotkeys } from 'react-hotkeys-hook';

import { Scope } from './registry';
import { useIsActivePane } from '@/shared/components/workspace-panes/PaneActiveContext';

interface UseEscapeToCloseOptions {
  /** Disable the handler (e.g. while the panel is closed). Defaults to true. */
  enabled?: boolean;
  /** Keyboard scope that owns the closeable surface. Defaults to Kanban. */
  scope?: Scope;
}

/**
 * Close a closeable surface on Escape, mirroring its close button. Shared by
 * Kanban right-panel variants and the workspace secondary panel so Escape
 * behaves consistently across both layouts.
 *
 * The owning keyboard scope keeps an open KeyboardDialog — which disables the
 * underlying page scope — first claim on Escape, so this never closes a panel
 * out from under a dialog. `enableOnFormTags` / `enableOnContentEditable` are
 * set because these panels autofocus a chat editor, so Escape must fire while
 * it holds focus.
 *
 * The `defaultPrevented` guard yields to anything that already handled Escape:
 * an in-editor handler (dismissing a mention/slash popup, exiting a code
 * block), a focused panel field that blurs first (the issue panel
 * `stopPropagation`s before this runs), and the kanban clear-selection handler.
 */
export function useEscapeToClose(
  onClose: () => void,
  options?: UseEscapeToCloseOptions
): void {
  // Every pane registers this hook; only the active pane's copy may close, so
  // Escape never closes a panel in an inactive pane. Defaults true outside the
  // pane grid.
  const isActivePane = useIsActivePane();
  useHotkeys(
    'escape',
    (e) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    },
    {
      scopes: [options?.scope ?? Scope.KANBAN],
      enabled: (options?.enabled ?? true) && isActivePane,
      enableOnFormTags: true,
      enableOnContentEditable: true,
    },
    [onClose]
  );
}
