import { useHotkeys } from 'react-hotkeys-hook';

import { Scope } from './registry';

interface UseEscapeToCloseOptions {
  /** Disable the handler (e.g. while the panel is closed). Defaults to true. */
  enabled?: boolean;
}

/**
 * Close a kanban right-sidebar panel on Escape, mirroring its X button. Shared
 * by every right-panel variant (issue, create-issue, workspace session,
 * workspace create) so Escape behaves identically across all of them.
 *
 * Scoped to KANBAN so an open KeyboardDialog — which disables the kanban scope
 * while open — keeps first claim on Escape and this never closes the panel out
 * from under a dialog. `enableOnFormTags` / `enableOnContentEditable` are set
 * because these panels autofocus a chat editor, so Escape must fire while it
 * holds focus.
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
      scopes: [Scope.KANBAN],
      enabled: options?.enabled ?? true,
      enableOnFormTags: true,
      enableOnContentEditable: true,
    },
    [onClose]
  );
}
