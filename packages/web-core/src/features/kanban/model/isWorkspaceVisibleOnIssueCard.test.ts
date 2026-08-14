import { describe, expect, it } from 'vitest';
import { isWorkspaceVisibleOnIssueCard } from './isWorkspaceVisibleOnIssueCard';

describe('isWorkspaceVisibleOnIssueCard', () => {
  it('hides a locally archived workspace while remote data is stale', () => {
    expect(
      isWorkspaceVisibleOnIssueCard(
        { archived: false, local_workspace_id: 'workspace-1' },
        new Set(['workspace-1'])
      )
    ).toBe(false);
  });

  it('keeps an active workspace without a local record visible', () => {
    expect(
      isWorkspaceVisibleOnIssueCard(
        { archived: false, local_workspace_id: 'remote-workspace' },
        new Set()
      )
    ).toBe(true);
  });
});
