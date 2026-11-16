import { describe, expect, it, vi } from 'vitest';
import { restoreDialogFocus } from '@vibe/ui/lib/dialog-keyboard';
import { isInInactiveWorkspacePane } from '@vibe/ui/lib/workspace-pane';

// Mirrors the contract WorkspacePaneGrid's PaneChrome publishes on its shell:
// `data-workspace-pane` marks a pane, `data-workspace-pane-active="true"` the
// active one.
function elementInPane(pane: { active: boolean } | null): Element {
  const shell = pane && {
    getAttribute: (name: string) =>
      name === 'data-workspace-pane-active' && pane.active ? 'true' : null,
  };
  return {
    closest: (selector: string) =>
      selector === '[data-workspace-pane]' ? shell : null,
  } as unknown as Element;
}

describe('isInInactiveWorkspacePane', () => {
  it('withholds focus only inside a pane shell that is not the active one', () => {
    expect(isInInactiveWorkspacePane(null)).toBe(false);
    // Outside the pane grid (mobile, dialogs) there is no shell: never withhold.
    expect(isInInactiveWorkspacePane(elementInPane(null))).toBe(false);
    expect(isInInactiveWorkspacePane(elementInPane({ active: true }))).toBe(
      false
    );
    expect(isInInactiveWorkspacePane(elementInPane({ active: false }))).toBe(
      true
    );
  });
});

describe('restoreDialogFocus', () => {
  // A dialog action that moved the active pane (palette "Workspace: …" landing
  // in another pane, a Drawer note opened as a page) must not be undone by
  // focusing back into the opener's pane — that re-activates it.
  function opener(pane: { active: boolean } | null) {
    const focus = vi.fn();
    const element = Object.assign(elementInPane(pane), {
      isConnected: true,
      focus,
    }) as unknown as HTMLElement;
    return { element, focus };
  }

  it('lands in the active pane instead of re-activating the opener pane', () => {
    const activePaneFocus = vi.fn();
    const insideActivePane = { closest: () => null } as unknown as Element;
    const doc = {
      activeElement: null as Element | null,
      querySelector: (selector: string) =>
        selector === '[data-workspace-pane-active="true"]'
          ? {
              focus: activePaneFocus,
              contains: (node: Element | null) => node === insideActivePane,
            }
          : null,
    };
    vi.stubGlobal('document', doc);
    try {
      const moved = opener({ active: false });
      restoreDialogFocus(moved.element);
      expect(moved.focus).not.toHaveBeenCalled();
      expect(activePaneFocus).toHaveBeenCalledTimes(1);
      // Focus the user (or the action) already put in that pane stays put.
      doc.activeElement = insideActivePane;
      restoreDialogFocus(moved.element);
      expect(activePaneFocus).toHaveBeenCalledTimes(1);
      doc.activeElement = null;

      const stayed = opener({ active: true });
      restoreDialogFocus(stayed.element);
      expect(stayed.focus).toHaveBeenCalled();

      const outside = opener(null);
      restoreDialogFocus(outside.element);
      expect(outside.focus).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
