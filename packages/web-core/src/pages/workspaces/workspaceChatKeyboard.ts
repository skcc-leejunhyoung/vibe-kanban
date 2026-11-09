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
  | { type: 'focus-composer' };

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
  return null;
}

/**
 * Cmd/Ctrl+Enter sends the composer from outside the editor, too; Shift adds
 * the editor's "steer" (send now) variant.
 */
export function resolveChatSubmitKey(
  event: WorkspaceChatKeyEvent
): { steer: boolean } | null {
  if (
    event.key !== 'Enter' ||
    !(event.metaKey || event.ctrlKey) ||
    event.altKey ||
    event.defaultPrevented ||
    event.isComposing
  ) {
    return null;
  }
  return { steer: event.shiftKey };
}

/**
 * The submit key works while the user moves around the chat by keyboard:
 * nothing focused, or a non-text control inside the chat (a chat box button,
 * a conversation entry). Text fields keep their own Cmd+Enter, and the agent
 * question banner confirms its own selection with it.
 */
export function shouldSubmitChatFromFocus(
  activeElement: Element | null,
  chatScope: Element | null
): boolean {
  if (shouldHandleUnfocusedChatKey(activeElement)) return true;
  if (!activeElement || !chatScope?.contains(activeElement)) return false;
  if ((activeElement as HTMLElement).isContentEditable) return false;
  return (
    !activeElement.matches('input, textarea, select') &&
    !activeElement.closest('[data-ask-user-question]')
  );
}

interface UnfocusedChatKeyTarget {
  scrollConversationBy: (delta: number) => boolean;
  focusComposer: () => boolean;
  /** Chat region whose non-text controls also accept the submit key. */
  getChatScope: () => Element | null;
  submitComposer: (steer: boolean) => boolean;
}

/**
 * The unfocused-chat keys act only while nothing interactive holds focus. The
 * pane shell (`data-workspace-pane`, focused by keyboard pane cycling) is not a
 * control, so it counts as "unfocused" — otherwise Enter/arrows are swallowed
 * the moment a pane is keyboard-selected.
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
 * is focused, plus Cmd+Enter submit (see `shouldSubmitChatFromFocus`).
 * `enabled` must fold in every caller-side condition (visible chat, active
 * pane, mobile tab), since panes register one listener each.
 */
export function useUnfocusedChatKeys(
  targetRef: RefObject<UnfocusedChatKeyTarget | null>,
  enabled: boolean
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
    };

    // Capture phase: a focused chat box button (Radix trigger) would otherwise
    // take Cmd+Enter as a plain Enter and open its menu first.
    const handleSubmitKey = (event: KeyboardEvent) => {
      if (isModalKeyboardActive()) return;
      const submit = resolveChatSubmitKey(event);
      const target = targetRef.current;
      if (
        !submit ||
        !target ||
        !shouldSubmitChatFromFocus(
          document.activeElement,
          target.getChatScope()
        ) ||
        !target.submitComposer(submit.steer)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keydown', handleSubmitKey, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', handleSubmitKey, true);
    };
  }, [enabled, targetRef]);
}
