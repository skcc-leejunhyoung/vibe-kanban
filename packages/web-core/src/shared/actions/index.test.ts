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
    getFirstUserMessage: vi.fn(),
    getRepos: vi.fn(),
    getWithSession: vi.fn(),
    getBranchStatus: vi.fn(),
    merge: vi.fn(),
    runSetupScript: vi.fn(),
    runCleanupScript: vi.fn(),
    runArchiveScript: vi.fn(),
  },
  relayApi: {},
  repoApi: {},
}));
vi.mock('@/shared/lib/remoteApi', () => ({
  bulkUpdateIssues: vi.fn(),
}));
vi.mock('@vibe/ui/components/ConfirmDialog', () => ({
  ConfirmDialog: {
    show: vi.fn(),
  },
}));

import { Actions } from './index';
import { workspacesApi } from '@/shared/lib/api';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';

const update = vi.mocked(workspacesApi.update);
const getBranchStatus = vi.mocked(workspacesApi.getBranchStatus);
const merge = vi.mocked(workspacesApi.merge);
const getFirstUserMessage = vi.mocked(workspacesApi.getFirstUserMessage);
const getRepos = vi.mocked(workspacesApi.getRepos);
const getWithSession = vi.mocked(workspacesApi.getWithSession);
const runSetupScript = vi.mocked(workspacesApi.runSetupScript);
const runCleanupScript = vi.mocked(workspacesApi.runCleanupScript);
const runArchiveScript = vi.mocked(workspacesApi.runArchiveScript);
const showConfirm = vi.mocked(ConfirmDialog.show);

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

describe('remote workspace action scoping', () => {
  it('loads duplicate seed data from the workspace host and keeps creation on that host', async () => {
    getFirstUserMessage.mockResolvedValue('prompt');
    getRepos.mockResolvedValue([]);
    getWithSession.mockResolvedValue({ workspace: {}, session: undefined });
    const goToWorkspacesCreate = vi.fn();
    const { ctx } = makeCtx(
      { id: 'remote-ws' },
      { appNavigation: { goToWorkspacesCreate } as never }
    );

    await Actions.DuplicateWorkspace.execute(ctx, 'remote-ws', 'host-2');

    expect(getFirstUserMessage).toHaveBeenCalledWith('remote-ws', 'host-2');
    expect(getRepos).toHaveBeenCalledWith('remote-ws', 'host-2');
    expect(getWithSession).toHaveBeenCalledWith('remote-ws', 'host-2');
    expect(goToWorkspacesCreate).toHaveBeenCalledWith({ hostId: 'host-2' });
  });

  it('routes all script actions to the workspace host', async () => {
    const success = { success: true, data: {} } as never;
    runSetupScript.mockResolvedValue(success);
    runCleanupScript.mockResolvedValue(success);
    runArchiveScript.mockResolvedValue(success);
    const { ctx } = makeCtx({ id: 'remote-ws' });

    await Actions.RunSetupScript.execute(ctx, 'remote-ws', 'host-2');
    await Actions.RunCleanupScript.execute(ctx, 'remote-ws', 'host-2');
    await Actions.RunArchiveScript.execute(ctx, 'remote-ws', 'host-2');

    expect(runSetupScript).toHaveBeenCalledWith('remote-ws', 'host-2');
    expect(runCleanupScript).toHaveBeenCalledWith('remote-ws', 'host-2');
    expect(runArchiveScript).toHaveBeenCalledWith('remote-ws', 'host-2');
  });
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

    expect(update).toHaveBeenCalledWith('ws1', { archived: true }, undefined);
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

    expect(update).toHaveBeenCalledWith('ws2', { archived: true }, undefined);
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it('unarchives by toggling archived=false without navigating', async () => {
    const { ctx, selectWorkspace } = makeCtx({ id: 'ws1', archived: true });

    await Actions.ArchiveWorkspace.execute(ctx, 'ws1');

    expect(update).toHaveBeenCalledWith('ws1', { archived: false }, undefined);
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it('sends archive mutations to the workspace host from the unified list', async () => {
    const { ctx, invalidateQueries } = makeCtx({
      id: 'remote-ws',
      archived: false,
    });

    await Actions.ArchiveWorkspace.execute(ctx, 'remote-ws', 'host-2');

    expect(update).toHaveBeenCalledWith(
      'remote-ws',
      { archived: true },
      'host-2'
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['workspaceRecord', 'host-2', 'remote-ws'],
    });
  });
});

describe('Actions.GitMerge', () => {
  const openPr = (headBranchName: string | null) => ({
    type: 'pr' as const,
    id: 'pr-1',
    workspace_id: 'ws1',
    repo_id: 'repo1',
    created_at: '2026-01-01T00:00:00Z',
    target_branch_name: 'main',
    head_branch_name: headBranchName,
    pr_info: {
      number: 1n,
      url: 'https://example.com/pull/1',
      status: 'open' as const,
      merged_at: null,
      merge_commit_sha: null,
    },
  });

  const branchStatusWithMerge = (mergeRecord: ReturnType<typeof openPr>) => [
    {
      repo_id: 'repo1',
      repo_name: 'repo',
      repo_missing: false,
      commits_behind: 0,
      commits_ahead: 1,
      has_uncommitted_changes: false,
      head_oid: 'abc',
      uncommitted_count: 0,
      untracked_count: 0,
      target_branch_name: 'feature',
      remote_commits_behind: null,
      remote_commits_ahead: null,
      merges: [mergeRecord],
      is_rebase_in_progress: false,
      conflict_op: null,
      conflicted_files: [],
      is_target_remote: false,
    },
  ];

  it('blocks direct merge for legacy open PRs whose null head means the workspace branch', async () => {
    const { ctx } = makeCtx({ id: 'ws1', branch: 'work' });
    getBranchStatus.mockResolvedValue(branchStatusWithMerge(openPr(null)));

    await Actions.GitMerge.execute(ctx, 'ws1', 'repo1');

    expect(showConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Cannot Merge' })
    );
    expect(merge).not.toHaveBeenCalled();
  });

  it('blocks direct merge when the open PR head is the workspace branch', async () => {
    const { ctx } = makeCtx({ id: 'ws1', branch: 'work' });
    getBranchStatus.mockResolvedValue(branchStatusWithMerge(openPr('work')));

    await Actions.GitMerge.execute(ctx, 'ws1', 'repo1');

    expect(showConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Cannot Merge' })
    );
    expect(merge).not.toHaveBeenCalled();
  });

  it('allows direct merge when the open PR is from an intermediate feature branch', async () => {
    const { ctx, invalidateQueries } = makeCtx({ id: 'ws1', branch: 'work' });
    getBranchStatus.mockResolvedValue(branchStatusWithMerge(openPr('feature')));
    showConfirm.mockResolvedValue('confirmed');

    await Actions.GitMerge.execute(ctx, 'ws1', 'repo1');

    expect(showConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Merge Branch' })
    );
    expect(merge).toHaveBeenCalledWith('ws1', { repo_id: 'repo1' });
    expect(invalidateQueries).toHaveBeenCalled();
  });
});

describe('workspace script host scope', () => {
  it.each([
    [Actions.RunSetupScript, runSetupScript],
    [Actions.RunCleanupScript, runCleanupScript],
    [Actions.RunArchiveScript, runArchiveScript],
  ])('forwards the target host for $id', async (action, apiCall) => {
    apiCall.mockResolvedValue({ success: true, data: {} } as never);
    const { ctx } = makeCtx({ id: 'remote-ws' });

    await action.execute(ctx, 'remote-ws', 'host-2');

    expect(apiCall).toHaveBeenCalledWith('remote-ws', 'host-2');
  });
});
