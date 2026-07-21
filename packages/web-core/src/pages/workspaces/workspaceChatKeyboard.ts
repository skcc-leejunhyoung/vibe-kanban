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
