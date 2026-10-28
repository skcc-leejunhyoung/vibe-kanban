import type { KeyboardEvent } from 'react';
import { activatesOnEnter } from '@vibe/ui/lib/dialog-keyboard';

export function handleDrawerDetailKeyDown(
  event: KeyboardEvent<HTMLElement>,
  actions: {
    backToList: () => void;
    navigateNote: (direction: -1 | 1) => void;
    focusComment: () => void;
  }
) {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return;
  const target = event.target as HTMLElement;
  if (!event.currentTarget.contains(target)) return;
  if (
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
    )
  )
    return;

  if (event.key === 'Escape') {
    event.preventDefault();
    actions.backToList();
    return;
  }
  if (event.altKey || event.shiftKey) return;
  if (event.metaKey || event.ctrlKey) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      actions.navigateNote(event.key === 'ArrowRight' ? 1 : -1);
    }
    return;
  }
  // Return on links and buttons keeps their native activation.
  if (event.key === 'Enter' && !activatesOnEnter(target)) {
    event.preventDefault();
    actions.focusComment();
  }
}
