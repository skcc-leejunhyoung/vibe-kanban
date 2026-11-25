import { isModalKeyboardActive } from './modal-keyboard';
import { isInInactiveWorkspacePane } from './workspace-pane';

export function handleIssuePanelKeyDown(
  event: KeyboardEvent,
  panel: HTMLDivElement,
  scroller: HTMLDivElement,
  titleInput: HTMLTextAreaElement | null
) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey ||
    isModalKeyboardActive() ||
    isInInactiveWorkspacePane(panel)
  ) {
    return;
  }

  const doc = panel.ownerDocument;
  const focused = doc.activeElement as HTMLElement | null;
  // Keyboard pane switching focuses the pane shell, not the issue itself.
  const isPanelSurfaceFocused =
    focused === panel ||
    focused === scroller ||
    (focused?.hasAttribute('data-workspace-pane') === true &&
      focused.contains(panel));

  if (event.key === 'Enter') {
    if (event.metaKey || !isPanelSurfaceFocused) return;
    titleInput?.focus();
    event.preventDefault();
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const isPanelScrollFocus =
      isPanelSurfaceFocused ||
      !focused ||
      focused === doc.body ||
      focused === doc.documentElement;

    if (event.metaKey) {
      // Non-editable panel controls (e.g. links) may also use the shortcut.
      if (
        !isPanelScrollFocus &&
        (!panel.contains(focused) ||
          focused?.isContentEditable ||
          focused?.closest(
            'input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"]'
          ))
      ) {
        return;
      }

      if (!event.repeat) {
        const reduceMotion = doc.defaultView?.matchMedia(
          '(prefers-reduced-motion: reduce)'
        ).matches;
        scroller.scrollTo({
          top: event.key === 'ArrowUp' ? 0 : scroller.scrollHeight,
          behavior: reduceMotion ? 'instant' : 'smooth',
        });
      }
      event.preventDefault();
    } else {
      if (!isPanelScrollFocus) return;
      // Let the browser scroll the focused element, including key repeat,
      // instead of jumping a fixed distance on every keydown.
      if (focused !== scroller) scroller.focus({ preventScroll: true });
    }
  } else {
    return;
  }

  // The issue panel owns these keys ahead of the board's navigation. Plain
  // arrows still reach the browser's default action (not the app listeners).
  event.stopImmediatePropagation();
}
