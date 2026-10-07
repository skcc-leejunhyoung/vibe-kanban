import { describe, expect, it } from 'vitest';
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
