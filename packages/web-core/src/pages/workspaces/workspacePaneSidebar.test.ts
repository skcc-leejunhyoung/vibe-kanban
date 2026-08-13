import { describe, expect, it } from 'vitest';
import {
  shouldCloseWorkspacePaneSidebarOnEscape,
  shouldShowWorkspacePaneSidebar,
} from './workspacePaneSidebar';

describe('shouldShowWorkspacePaneSidebar', () => {
  it('keeps a wide pane sidebar mounted while another pane is active', () => {
    expect(
      shouldShowWorkspacePaneSidebar({
        isVisible: true,
        isPaneActive: false,
        isCompact: false,
        isCreateMode: false,
      })
    ).toBe(true);
  });

  it('only shows a compact pane sidebar while that pane is active', () => {
    expect(
      shouldShowWorkspacePaneSidebar({
        isVisible: true,
        isPaneActive: false,
        isCompact: true,
        isCreateMode: false,
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
