import { describe, expect, it } from 'vitest';
import {
  shouldCloseWorkspacePaneSidebarOnEscape,
  shouldShowWorkspacePaneSidebar,
} from './workspacePaneSidebar';

describe('shouldShowWorkspacePaneSidebar', () => {
  it('shows a visible workspace sidebar', () => {
    expect(
      shouldShowWorkspacePaneSidebar({
        isVisible: true,
        isCreateMode: false,
      })
    ).toBe(true);
  });

  it('hides the sidebar in create mode', () => {
    expect(
      shouldShowWorkspacePaneSidebar({
        isVisible: true,
        isCreateMode: true,
      })
    ).toBe(false);
  });

  it('closes a compact active Git sidebar on Escape', () => {
    expect(
      shouldCloseWorkspacePaneSidebarOnEscape({
        isVisible: true,
        isPaneActive: true,
        isCompact: true,
        rightMainPanelOpen: false,
      })
    ).toBe(true);
  });
});
