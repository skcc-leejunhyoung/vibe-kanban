import { useEffect } from 'react';
import { isModalKeyboardActive } from '@vibe/ui/lib/modal-keyboard';

export function blurFocusedElementOnEscape(
  event: Pick<KeyboardEvent, 'key' | 'preventDefault'>,
  activeElement: Element | null
): void {
  if (event.key !== 'Escape' || !activeElement) return;

  if (
    typeof activeElement.closest === 'function' &&
    activeElement.closest('[data-escape-handled]')
  ) {
    return;
  }

  // BODY/HTML represent the unfocused document. Leave Escape available to
  // close the current panel when there is no real element to blur.
  if (activeElement.tagName === 'BODY' || activeElement.tagName === 'HTML') {
    return;
  }

  // In the split-screen parent, the active iframe represents the pane itself.
  // Keep that focus so pane-level keyboard navigation continues to work; the
  // embedded document handles Escape for controls focused inside the pane.
  if (activeElement.tagName === 'IFRAME') return;

  if ('blur' in activeElement && typeof activeElement.blur === 'function') {
    activeElement.blur();
    // The first Escape belongs to focus dismissal. Downstream panel handlers
    // observe defaultPrevented and only close on a subsequent Escape.
    event.preventDefault();
  }
}

export function useEscapeToBlur(): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isModalKeyboardActive()) return;
      blurFocusedElementOnEscape(event, document.activeElement);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, []);
}
