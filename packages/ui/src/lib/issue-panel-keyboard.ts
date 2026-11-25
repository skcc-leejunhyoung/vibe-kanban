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
    (focused?.hasAttribute('data-workspace-pane') === true &&
      focused.contains(panel));

  if (event.key === 'Enter') {
    if (event.metaKey || !isPanelSurfaceFocused) return;
    titleInput?.focus();
    event.preventDefault();
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const isPanelScrollFocus =
      isPanelSurfaceFocused ||
      focused === scroller ||
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
    } else if (!isPanelScrollFocus) {
      return;
    }

    if (!event.metaKey || !event.repeat) {
      const behavior = doc.defaultView?.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches
        ? 'instant'
        : 'smooth';
      const up = event.key === 'ArrowUp';
      if (event.metaKey) {
        scroller.scrollTo({ top: up ? 0 : scroller.scrollHeight, behavior });
      } else {
        // Scroll the content without moving focus past the header's Tab stops.
        scroller.scrollBy({ top: up ? -80 : 80, behavior });
      }
    }
    event.preventDefault();
  } else {
    return;
  }

  // The issue panel owns these keys ahead of the board's navigation.
  event.stopImmediatePropagation();
}
