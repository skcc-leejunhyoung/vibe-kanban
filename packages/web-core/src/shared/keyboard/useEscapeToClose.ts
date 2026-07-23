import { useHotkeys } from 'react-hotkeys-hook';

import { Scope } from './registry';

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
  useHotkeys(
    'escape',
    (e) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    },
    {
      scopes: [options?.scope ?? Scope.KANBAN],
      enabled: options?.enabled ?? true,
      enableOnFormTags: true,
      enableOnContentEditable: true,
    },
    [onClose]
  );
}
