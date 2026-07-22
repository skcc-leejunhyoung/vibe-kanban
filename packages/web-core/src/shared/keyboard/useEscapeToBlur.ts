import { useEffect } from 'react';

export function blurFocusedElementOnEscape(
  event: Pick<KeyboardEvent, 'key'>,
  activeElement: Element | null
): void {
  if (event.key !== 'Escape' || !activeElement) return;

  // In the split-screen parent, the active iframe represents the pane itself.
  // Keep that focus so pane-level keyboard navigation continues to work; the
  // embedded document handles Escape for controls focused inside the pane.
  if (activeElement.tagName === 'IFRAME') return;

  if ('blur' in activeElement && typeof activeElement.blur === 'function') {
    activeElement.blur();
  }
}

export function useEscapeToBlur(): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      blurFocusedElementOnEscape(event, document.activeElement);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, []);
}
