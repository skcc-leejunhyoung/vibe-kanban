import { describe, expect, it } from 'vitest';
import type { WorkspacePaneDestination } from '@/shared/stores/useWorkspacePanesStore';
import {
  shouldAdoptDocumentDestination,
  shouldParkEmptyPaneUrl,
} from './workspacePaneNavigation';

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

describe('shouldParkEmptyPaneUrl', () => {
  it('parks a stale renderable URL when the active pane is empty', () => {
    // The stale URL below is exactly what the adopt effect would re-adopt,
    // snapping the active pane off the empty one (cmd+t / alt+tab focus bug).
    expect(shouldAdoptDocumentDestination(workspace('a'), null, null)).toBe(
      true
    );
    expect(shouldParkEmptyPaneUrl(null, workspace('a'))).toBe(true);
  });

  it('does not park once the URL is already the bare grid route', () => {
    expect(shouldParkEmptyPaneUrl(null, { kind: 'workspaces' })).toBe(false);
  });

  it('never parks when the active pane has content', () => {
    expect(shouldParkEmptyPaneUrl(workspace('a'), workspace('b'))).toBe(false);
  });
});
