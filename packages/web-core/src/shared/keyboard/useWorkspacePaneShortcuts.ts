import { useCallback } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import {
  NEXT_SPLIT_PANE_BINDING_ID,
  PREVIOUS_SPLIT_PANE_BINDING_ID,
  SPLIT_PRESET_BINDING_IDS,
  resolveModifier,
} from '@/shared/keyboard/registry';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import { applyWorkspacePaneCount } from '@/shared/lib/openInSplitPane';
import { useWorkspacePanesStore } from '@/shared/stores/useWorkspacePanesStore';

function hotkeyOptions(keys: string) {
  return {
    enabled: !!keys,
    enableOnContentEditable: true,
    enableOnFormTags: true,
    preventDefault: true,
    scopes: ['global'],
  };
}

/**
 * Global split-pane shortcuts: mod+alt+shift+N sets the visible pane count,
 * alt+tab / shift+alt+tab cycle pane focus. Mounted once per document.
 */
export function useWorkspacePaneShortcuts() {
  const appNavigation = useAppNavigation();
  const overrides = useKeyboardShortcutsStore((state) => state.overrides);
  const maxPanes = useWorkspacePanesStore((state) => state.maxPanes);
  const cycleActivePane = useWorkspacePanesStore(
    (state) => state.cycleActivePane
  );

  const setCount = useCallback(
    (total: number) => (event: KeyboardEvent) => {
      event.preventDefault();
      applyWorkspacePaneCount(total, appNavigation);
    },
    [appNavigation]
  );

  const bind = (count: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9) =>
    count <= maxPanes
      ? resolveModifier(SPLIT_PRESET_BINDING_IDS[count], overrides)
      : '';
  const one = bind(1);
  const two = bind(2);
  const three = bind(3);
  const four = bind(4);
  const five = bind(5);
  const six = bind(6);
  const seven = bind(7);
  const eight = bind(8);
  const nine = bind(9);
  useHotkeys(one || 'unidentified', setCount(1), hotkeyOptions(one), [
    one,
    setCount,
  ]);
  useHotkeys(two || 'unidentified', setCount(2), hotkeyOptions(two), [
    two,
    setCount,
  ]);
  useHotkeys(three || 'unidentified', setCount(3), hotkeyOptions(three), [
    three,
    setCount,
  ]);
  useHotkeys(four || 'unidentified', setCount(4), hotkeyOptions(four), [
    four,
    setCount,
  ]);
  useHotkeys(five || 'unidentified', setCount(5), hotkeyOptions(five), [
    five,
    setCount,
  ]);
  useHotkeys(six || 'unidentified', setCount(6), hotkeyOptions(six), [
    six,
    setCount,
  ]);
  useHotkeys(seven || 'unidentified', setCount(7), hotkeyOptions(seven), [
    seven,
    setCount,
  ]);
  useHotkeys(eight || 'unidentified', setCount(8), hotkeyOptions(eight), [
    eight,
    setCount,
  ]);
  useHotkeys(nine || 'unidentified', setCount(9), hotkeyOptions(nine), [
    nine,
    setCount,
  ]);

  const nextKeys = resolveModifier(NEXT_SPLIT_PANE_BINDING_ID, overrides);
  const previousKeys = resolveModifier(
    PREVIOUS_SPLIT_PANE_BINDING_ID,
    overrides
  );
  useHotkeys(
    nextKeys || 'unidentified',
    (event) => {
      event.preventDefault();
      cycleActivePane('next');
    },
    hotkeyOptions(nextKeys),
    [nextKeys, cycleActivePane]
  );
  useHotkeys(
    previousKeys || 'unidentified',
    (event) => {
      event.preventDefault();
      cycleActivePane('previous');
    },
    hotkeyOptions(previousKeys),
    [previousKeys, cycleActivePane]
  );
}
