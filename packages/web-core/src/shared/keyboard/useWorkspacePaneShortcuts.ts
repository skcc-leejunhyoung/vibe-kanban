import { useCallback } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import {
  CLOSE_PANE_BINDING_ID,
  NEW_PANE_BINDING_ID,
  NEXT_SPLIT_PANE_BINDING_ID,
  PREVIOUS_SPLIT_PANE_BINDING_ID,
  SPLIT_PRESET_BINDING_IDS,
  resolveModifier,
} from '@/shared/keyboard/registry';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import {
  closeActivePane,
  focusPaneAt,
  openNewPane,
} from '@/shared/lib/openInSplitPane';
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
 * Global split-pane shortcuts, VS Code style: mod+alt+shift+N focuses the
 * pane at that position (never creates one), mod+t opens a new pane next to
 * the active one, mod+w closes the focused pane, and alt+tab / shift+alt+tab
 * cycle pane focus. Mounted once per document.
 */
export function useWorkspacePaneShortcuts() {
  const appNavigation = useAppNavigation();
  const overrides = useKeyboardShortcutsStore((state) => state.overrides);
  const maxPanes = useWorkspacePanesStore((state) => state.maxPanes);
  const cycleActivePane = useWorkspacePanesStore(
    (state) => state.cycleActivePane
  );

  const focusAt = useCallback(
    (index: number) => (event: KeyboardEvent) => {
      event.preventDefault();
      focusPaneAt(index, appNavigation);
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
  useHotkeys(one || 'unidentified', focusAt(0), hotkeyOptions(one), [
    one,
    focusAt,
  ]);
  useHotkeys(two || 'unidentified', focusAt(1), hotkeyOptions(two), [
    two,
    focusAt,
  ]);
  useHotkeys(three || 'unidentified', focusAt(2), hotkeyOptions(three), [
    three,
    focusAt,
  ]);
  useHotkeys(four || 'unidentified', focusAt(3), hotkeyOptions(four), [
    four,
    focusAt,
  ]);
  useHotkeys(five || 'unidentified', focusAt(4), hotkeyOptions(five), [
    five,
    focusAt,
  ]);
  useHotkeys(six || 'unidentified', focusAt(5), hotkeyOptions(six), [
    six,
    focusAt,
  ]);
  useHotkeys(seven || 'unidentified', focusAt(6), hotkeyOptions(seven), [
    seven,
    focusAt,
  ]);
  useHotkeys(eight || 'unidentified', focusAt(7), hotkeyOptions(eight), [
    eight,
    focusAt,
  ]);
  useHotkeys(nine || 'unidentified', focusAt(8), hotkeyOptions(nine), [
    nine,
    focusAt,
  ]);

  const newPaneKeys = resolveModifier(NEW_PANE_BINDING_ID, overrides);
  useHotkeys(
    newPaneKeys || 'unidentified',
    (event) => {
      event.preventDefault();
      openNewPane(appNavigation);
    },
    hotkeyOptions(newPaneKeys),
    [newPaneKeys, appNavigation]
  );

  const closePaneKeys = resolveModifier(CLOSE_PANE_BINDING_ID, overrides);
  useHotkeys(
    closePaneKeys || 'unidentified',
    (event) => {
      event.preventDefault();
      closeActivePane(appNavigation);
    },
    hotkeyOptions(closePaneKeys),
    [closePaneKeys, appNavigation]
  );

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
