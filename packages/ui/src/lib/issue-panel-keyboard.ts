import { isModalKeyboardActive } from './modal-keyboard';
import { isInInactiveWorkspacePane } from './workspace-pane';

type ScrollAnimation = {
  target: number;
  position: number;
  time: number | null;
  frame: number;
};

const scrollAnimations = new WeakMap<HTMLDivElement, ScrollAnimation>();

function stopScroll(scroller: HTMLDivElement, view: Window) {
  const animation = scrollAnimations.get(scroller);
  if (animation) view.cancelAnimationFrame(animation.frame);
  scrollAnimations.delete(scroller);
}

function scrollBySmoothly(
  scroller: HTMLDivElement,
  view: Window,
  delta: number
) {
  let animation = scrollAnimations.get(scroller);
  if (animation && scroller.scrollTop !== animation.position) {
    stopScroll(scroller, view);
    animation = undefined;
  }
  if (!animation) {
    // Cancel any native Cmd+arrow animation before taking over.
    scroller.scrollTo({ top: scroller.scrollTop, behavior: 'instant' });
    animation = {
      target: scroller.scrollTop,
      position: scroller.scrollTop,
      time: null,
      frame: 0,
    };
    scrollAnimations.set(scroller, animation);
    const current = animation;
    const step = (time: number) => {
      if (scroller.scrollTop !== current.position) {
        stopScroll(scroller, view);
        return;
      }
      const elapsed =
        current.time === null ? 16 : Math.min(time - current.time, 100);
      current.time = time;
      current.target = Math.min(
        current.target,
        Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      );
      const remaining = current.target - current.position;
      const previous = current.position;
      scroller.scrollTop =
        Math.abs(remaining) < 3
          ? current.target
          : current.position + remaining * (1 - Math.exp(-elapsed / 65));
      current.position = scroller.scrollTop;
      if (
        Math.abs(current.target - current.position) < 1 ||
        current.position === previous
      ) {
        scroller.scrollTop = current.target;
        scrollAnimations.delete(scroller);
      } else {
        current.frame = view.requestAnimationFrame(step);
      }
    };
    current.frame = view.requestAnimationFrame(step);
  }
  if ((animation.target - animation.position) * delta < 0) {
    animation.target = animation.position;
  }
  animation.target = Math.max(
    0,
    Math.min(
      scroller.scrollHeight - scroller.clientHeight,
      animation.target + delta
    )
  );
}

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
      const view = doc.defaultView;
      const behavior = view?.matchMedia('(prefers-reduced-motion: reduce)')
        .matches
        ? 'instant'
        : 'smooth';
      const up = event.key === 'ArrowUp';
      if (event.metaKey) {
        if (view) stopScroll(scroller, view);
        scroller.scrollTo({ top: up ? 0 : scroller.scrollHeight, behavior });
      } else if (behavior === 'instant' || !view) {
        if (view) stopScroll(scroller, view);
        scroller.scrollBy({ top: up ? -80 : 80, behavior });
      } else {
        scrollBySmoothly(scroller, view, up ? -80 : 80);
      }
    }
    event.preventDefault();
  } else {
    return;
  }

  // The issue panel owns these keys ahead of the board's navigation.
  event.stopImmediatePropagation();
}
