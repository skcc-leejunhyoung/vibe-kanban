export function getNextNotificationIndex(
  itemCount: number,
  currentIndex: number,
  direction: 'next' | 'previous'
): number | null {
  if (itemCount === 0) return null;

  if (currentIndex < 0 || currentIndex >= itemCount) {
    return direction === 'next' ? 0 : itemCount - 1;
  }

  return direction === 'next'
    ? (currentIndex + 1) % itemCount
    : (currentIndex - 1 + itemCount) % itemCount;
}

export function isNotificationKeyboardControl(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;

  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)
  );
}

export function isNotificationActivationKey(key: string) {
  return key === 'Enter' || key === ' ';
}
