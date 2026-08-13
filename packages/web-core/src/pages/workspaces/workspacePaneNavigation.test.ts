import { describe, expect, it } from 'vitest';
import type { WorkspacePaneDestination } from '@/shared/stores/useWorkspacePanesStore';
import { shouldAdoptDocumentDestination } from './workspacePaneNavigation';

const workspace = (workspaceId: string): WorkspacePaneDestination => ({
  kind: 'workspace',
  workspaceId,
  hostId: null,
});
const pullRequests: WorkspacePaneDestination = { kind: 'pull-requests' };

describe('shouldAdoptDocumentDestination', () => {
  it('does not undo internal workspace and pull-request transitions', () => {
    expect(
      shouldAdoptDocumentDestination(
        workspace('a'),
        pullRequests,
        workspace('a')
      )
    ).toBe(false);
    expect(
      shouldAdoptDocumentDestination(pullRequests, workspace('a'), pullRequests)
    ).toBe(false);
  });

  it('adopts external navigation when the active pane did not change', () => {
    expect(
      shouldAdoptDocumentDestination(
        workspace('b'),
        workspace('a'),
        workspace('a')
      )
    ).toBe(true);
  });

  it('adopts the document destination on initial mount', () => {
    expect(
      shouldAdoptDocumentDestination(workspace('b'), workspace('a'), undefined)
    ).toBe(true);
  });
});
