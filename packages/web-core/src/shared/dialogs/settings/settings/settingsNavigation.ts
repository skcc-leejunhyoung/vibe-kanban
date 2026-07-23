/**
 * Finds the next enabled item for a roving-focus list, wrapping at either end.
 */
export function nextSettingsSection<T>(
  sections: readonly T[],
  currentSection: T,
  direction: 'next' | 'previous',
  isDisabled: (section: T) => boolean
): T {
  const enabledSections = sections.filter((section) => !isDisabled(section));

  if (enabledSections.length === 0) return currentSection;

  const currentIndex = enabledSections.indexOf(currentSection);
  const offset = direction === 'next' ? 1 : -1;
  const nextIndex =
    currentIndex === -1
      ? direction === 'next'
        ? 0
        : enabledSections.length - 1
      : (currentIndex + offset + enabledSections.length) %
        enabledSections.length;

  return enabledSections[nextIndex];
}

/** Focuses an element only while it participates in the rendered layout. */
export function focusIfVisible(
  element:
    | {
        offsetParent: Element | null;
        focus: () => void;
      }
    | undefined
): boolean {
  if (!element || element.offsetParent === null) return false;

  element.focus();
  return true;
}
