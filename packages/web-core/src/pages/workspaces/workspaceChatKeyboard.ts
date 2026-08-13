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

      const activeElement = document.activeElement;
      const hasNoFocusedControl =
        activeElement === null ||
        activeElement === document.body ||
        activeElement === document.documentElement;
      if (!hasNoFocusedControl) return;

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
