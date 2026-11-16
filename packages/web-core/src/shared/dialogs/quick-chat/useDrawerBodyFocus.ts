import { useEffect, useRef, type RefObject } from 'react';
import { isModalKeyboardActive } from '@vibe/ui/lib/modal-keyboard';
import { isLayeredAbove } from '@vibe/ui/lib/dialog-keyboard';

export function useDrawerBodyFocus(
  bodyRef: RefObject<HTMLDivElement>,
  {
    noteId,
    enabled,
    narrow,
    focusRequest,
  }: {
    noteId: string;
    enabled: boolean;
    narrow: boolean;
    focusRequest: number;
  }
) {
  const previousNote = useRef<string | null>(null);
  const previousRequest = useRef(focusRequest);

  useEffect(() => {
    const body = bodyRef.current;
    const noteChanged = previousNote.current !== noteId;
    const requested = previousRequest.current !== focusRequest;
    previousNote.current = noteId;
    previousRequest.current = focusRequest;
    if (!body) return;
    // Switching panes or layouts must keep the reader's place.
    if (noteChanged) body.scrollTop = 0;
    if (!enabled) return;

    const active = document.activeElement;
    const dialog = body.closest('[role="dialog"]');
    if (isModalKeyboardActive()) {
      if (!dialog) return;
      if (
        active &&
        active !== document.body &&
        !dialog.contains(active) &&
        isLayeredAbove(dialog, active)
      )
        return;
    }

    const detail = body.closest('[data-drawer-detail]');
    const unfocused =
      !active ||
      active === document.body ||
      active === document.documentElement ||
      active.hasAttribute('data-workspace-pane');
    const hiddenListFocus =
      narrow &&
      !!active &&
      !!detail?.parentElement?.contains(active) &&
      !detail.contains(active);
    if (noteChanged || requested || unfocused || hiddenListFocus) {
      body.focus({ preventScroll: true });
    }
  }, [bodyRef, noteId, enabled, narrow, focusRequest]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!enabled || !body) return;
    const pane = body.closest('[data-workspace-pane]');
    if (!pane) return;
    // Pane cycling focuses its shell after child effects have already run.
    // A press focuses the shell too (mousedown's default), but moving focus
    // mid-press cancels the drag it starts, e.g. moving the pane by its header.
    let pressed = false;
    const press = () => {
      pressed = true;
      setTimeout(() => (pressed = false));
    };
    const focusBody = () => {
      if (!pressed && !isModalKeyboardActive()) {
        body.focus({ preventScroll: true });
      }
    };
    pane.addEventListener('mousedown', press, true);
    pane.addEventListener('focus', focusBody);
    return () => {
      pane.removeEventListener('mousedown', press, true);
      pane.removeEventListener('focus', focusBody);
    };
  }, [bodyRef, enabled]);
}
