import { isPlainEscape } from '@vibe/ui/lib/dialog-keyboard';

const DETAIL_CONTROL_SELECTOR =
  'input, textarea, select, button, a, [role="button"], [contenteditable="true"]';

interface EscapeEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

interface FocusedElement {
  closest(selector: string): Element | null;
  blur?(): void;
}

export function handlePullRequestDetailsEscape(
  event: EscapeEvent,
  activeElement: FocusedElement | null,
  closeDetails: () => void
): void {
  if (!isPlainEscape(event) || event.defaultPrevented) return;

  if (
    activeElement?.closest(DETAIL_CONTROL_SELECTOR) &&
    typeof activeElement.blur === 'function'
  ) {
    event.preventDefault();
    activeElement.blur();
    return;
  }

  event.preventDefault();
  closeDetails();
}
