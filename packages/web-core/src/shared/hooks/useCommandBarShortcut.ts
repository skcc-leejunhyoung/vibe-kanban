import { useEffect, useCallback } from 'react';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import {
  COMMAND_BAR_BINDING_ID,
  matchesCombo,
  resolveModifier,
} from '@/shared/keyboard/registry';
import { isModalKeyboardActive } from '@vibe/ui/lib/modal-keyboard';

/**
 * Hook that listens for the command bar shortcut (default Cmd/Ctrl+K, but
 * user-rebindable via Keyboard Shortcuts settings) to open the command bar.
 * Uses a native DOM listener in the capture phase to intercept before other
 * handlers like the Lexical editor.
 */
export function useCommandBarShortcut(
  onOpen: () => void,
  enabled: boolean = true
) {
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);
  const combo = resolveModifier(COMMAND_BAR_BINDING_ID, overrides);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (isModalKeyboardActive()) return;
      if (matchesCombo(event, combo)) {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }
    },
    [onOpen, combo]
  );

  useEffect(() => {
    if (!enabled) return;

    // Use capture phase to intercept before other handlers (like Lexical editor)
    window.addEventListener('keydown', handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [handleKeyDown, enabled]);
}
