import { useEffect, useCallback } from 'react';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import {
  COMMAND_BAR_BINDING_ID,
  resolveModifier,
} from '@/shared/keyboard/registry';
import { isMac } from '@/shared/lib/platform';

/**
 * Match a KeyboardEvent against a combo string like 'mod+k'.
 * 'mod' maps to Cmd on macOS and Ctrl elsewhere. All other modifiers must
 * match exactly so e.g. 'mod+k' does not also fire on Cmd+Shift+K.
 */
function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop();
  if (!key) return false;
  const mac = isMac();
  const wantMod = parts.includes('mod');
  const wantMeta = parts.includes('meta') || (wantMod && mac);
  const wantCtrl = parts.includes('ctrl') || (wantMod && !mac);
  const wantShift = parts.includes('shift');
  const wantAlt = parts.includes('alt');

  return (
    event.key.toLowerCase() === key &&
    event.metaKey === wantMeta &&
    event.ctrlKey === wantCtrl &&
    event.shiftKey === wantShift &&
    event.altKey === wantAlt
  );
}

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
