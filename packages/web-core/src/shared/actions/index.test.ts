import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Workspace } from 'shared/types';
import type { ActionExecutorContext } from '@/shared/types/actions';

// `actions/index.ts` is a heavy barrel: its action `execute` bodies reference
// dialog components, icons, posthog and stores, so importing it transitively
// pulls in the whole UI graph. Shim the pieces that can't load in the `node`
// test environment (the executor-schemas Vite virtual module) and stub the API
// layer so no network call can fire.
vi.mock('virtual:executor-schemas', () => ({ default: {} }));
vi.mock('@/shared/lib/api', () => ({
  workspacesApi: {
    update: vi.fn(),
    get: vi.fn(),
  },
  relayApi: {},
  repoApi: {},
}));
vi.mock('@/shared/lib/remoteApi', () => ({
  bulkUpdateIssues: vi.fn(),
}));

import { Actions } from './index';
import { workspacesApi } from '@/shared/lib/api';

const update = vi.mocked(workspacesApi.update);

// Build a minimal action context. Seeding the query cache with the workspace
// keeps `getWorkspace` off the (stubbed) network path. `currentWorkspaceId` and
// `activeWorkspaces` are populated so that, if archive ever regressed back to
// navigating, `getNextWorkspaceId` would have a neighbour to jump to — making a
// stray `selectWorkspace` call observable.
function makeCtx(
  cachedWorkspace: Partial<Workspace>,
  overrides: Partial<ActionExecutorContext> = {}
) {
  const selectWorkspace = vi.fn();
  const invalidateQueries = vi.fn();
  const ctx = {
    queryClient: {
      getQueryData: vi.fn(() => cachedWorkspace),
      invalidateQueries,
    },
    selectWorkspace,
    currentWorkspaceId: 'ws1',
    activeWorkspaces: [
      { id: 'ws1', isRunning: false },
      { id: 'ws2', isRunning: false },
    ],
    ...overrides,
  } as unknown as ActionExecutorContext;
  return { ctx, selectWorkspace, invalidateQueries };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Actions.ArchiveWorkspace', () => {
  it('imports cleanly and exposes an executable action', () => {
    expect(typeof Actions.ArchiveWorkspace.execute).toBe('function');
  });

  it('archives by toggling archived=true without navigating, even when archiving the currently-viewed workspace', async () => {
    const { ctx, selectWorkspace, invalidateQueries } = makeCtx(
      { id: 'ws1', archived: false },
      { currentWorkspaceId: 'ws1' }
    );

    await Actions.ArchiveWorkspace.execute(ctx, 'ws1');

    expect(update).toHaveBeenCalledWith('ws1', { archived: true });
    expect(invalidateQueries).toHaveBeenCalled();
    // Regression guard: archiving must never jump to a neighbouring workspace.
    // This previously yanked mobile users into a different workspace's screen.
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it('does not navigate when archiving a workspace other than the current one', async () => {
    const { ctx, selectWorkspace } = makeCtx(
      { id: 'ws2', archived: false },
      { currentWorkspaceId: 'ws1' }
    );

    await Actions.ArchiveWorkspace.execute(ctx, 'ws2');

    expect(update).toHaveBeenCalledWith('ws2', { archived: true });
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it('unarchives by toggling archived=false without navigating', async () => {
    const { ctx, selectWorkspace } = makeCtx({ id: 'ws1', archived: true });

    await Actions.ArchiveWorkspace.execute(ctx, 'ws1');

    expect(update).toHaveBeenCalledWith('ws1', { archived: false });
    expect(selectWorkspace).not.toHaveBeenCalled();
  });
});
