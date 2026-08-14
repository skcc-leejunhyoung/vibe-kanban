import { useEffect, type RefObject } from 'react';
import { isModalKeyboardActive } from '@vibe/ui/lib/modal-keyboard';

type WorkspaceChatKeyEvent = Pick<
  KeyboardEvent,
  | 'key'
  | 'defaultPrevented'
  | 'isComposing'
  | 'metaKey'
  | 'ctrlKey'
  | 'altKey'
  | 'shiftKey'
>;

export type WorkspaceChatKeyAction =
  | { type: 'scroll'; delta: number }
  | { type: 'focus-composer' }
  | { type: 'focus-workspaces' };

export function resolveUnfocusedChatKeyAction(
  event: WorkspaceChatKeyEvent
): WorkspaceChatKeyAction | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return null;
  }

  if (event.key === 'ArrowUp') return { type: 'scroll', delta: -80 };
  if (event.key === 'ArrowDown') return { type: 'scroll', delta: 80 };
  if (event.key === 'Enter') return { type: 'focus-composer' };
  if (event.key === 'Escape') return { type: 'focus-workspaces' };
  return null;
}

interface UnfocusedChatKeyTarget {
  scrollConversationBy: (delta: number) => boolean;
  focusComposer: () => boolean;
}

/**
 * The unfocused-chat keys act only while nothing interactive holds focus. The
 * pane shell (`data-workspace-pane`, focused by keyboard pane cycling) is not a
 * control, so it counts as "unfocused" — otherwise Enter/arrows/Esc are
 * swallowed the moment a pane is keyboard-selected.
 */
export function shouldHandleUnfocusedChatKey(
  activeElement: Element | null
): boolean {
  if (activeElement === null) return true;
  const name = activeElement.nodeName;
  if (name === 'BODY' || name === 'HTML') return true;
  return activeElement.hasAttribute('data-workspace-pane');
}

/**
 * Window-level ArrowUp/ArrowDown/Enter handling for the chat while no control
 * is focused. `enabled` must fold in every caller-side condition (visible
 * chat, active pane, mobile tab), since panes register one listener each.
 */
export function useUnfocusedChatKeys(
  targetRef: RefObject<UnfocusedChatKeyTarget | null>,
  enabled: boolean,
  onEscape?: () => void
) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isModalKeyboardActive()) return;

      if (!shouldHandleUnfocusedChatKey(document.activeElement)) return;

      const action = resolveUnfocusedChatKeyAction(event);
      if (action?.type === 'scroll') {
        if (targetRef.current?.scrollConversationBy(action.delta)) {
          event.preventDefault();
        }
        return;
      }

      if (
        action?.type === 'focus-composer' &&
        targetRef.current?.focusComposer()
      ) {
        event.preventDefault();
      }

      if (action?.type === 'focus-workspaces' && onEscape) {
        event.preventDefault();
        onEscape();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, onEscape, targetRef]);
}
