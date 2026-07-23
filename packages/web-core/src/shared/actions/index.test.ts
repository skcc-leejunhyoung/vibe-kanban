import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Workspace } from 'shared/types';
import {
  isActionVisible,
  type ActionExecutorContext,
  type ActionVisibilityContext,
} from '@/shared/types/actions';

// `actions/index.ts` is a heavy barrel: its action `execute` bodies reference
// dialog components, icons, and stores, so importing it transitively
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
    push: vi.fn(),
    pushTargetBranch: vi.fn(),
  },
  relayApi: {},
  repoApi: {},
  sessionsApi: {
    getByWorkspace: vi.fn(),
    vibeReview: vi.fn(),
  },
}));
vi.mock('@/shared/lib/remoteApi', () => ({
  bulkUpdateIssues: vi.fn(),
}));
vi.mock('@vibe/ui/components/ConfirmDialog', () => ({
  ConfirmDialog: {
    show: vi.fn(),
  },
}));
vi.mock('@/shared/dialogs/command-bar/PullFirstDialog', () => ({
  PullFirstDialog: { show: vi.fn() },
}));
vi.mock('@/shared/dialogs/command-bar/ForcePushDialog', () => ({
  ForcePushDialog: { show: vi.fn() },
}));
vi.mock('@vibe/ui/lib/open-url', () => ({
  openExternalUrl: vi.fn(),
  reserveExternalWindow: vi.fn(),
}));
vi.mock('@/shared/lib/openInSplitPane', () => ({
  openInSplitPane: vi.fn(),
}));

import { Actions, getSessionCommandLabel } from './index';
import { formatDateShortWithTime } from '@/shared/lib/date';
import { sessionsApi, workspacesApi } from '@/shared/lib/api';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { PullFirstDialog } from '@/shared/dialogs/command-bar/PullFirstDialog';
import { ForcePushDialog } from '@/shared/dialogs/command-bar/ForcePushDialog';
import { openExternalUrl, reserveExternalWindow } from '@vibe/ui/lib/open-url';
import { openInSplitPane } from '@/shared/lib/openInSplitPane';

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
const push = vi.mocked(workspacesApi.push);
const pushTargetBranch = vi.mocked(workspacesApi.pushTargetBranch);
const showPullFirst = vi.mocked(PullFirstDialog.show);
const showForcePush = vi.mocked(ForcePushDialog.show);
const openPrUrl = vi.mocked(openExternalUrl);
const reservePrWindow = vi.mocked(reserveExternalWindow);
const openWorkspaceInSplitPane = vi.mocked(openInSplitPane);
const getSessionsByWorkspace = vi.mocked(sessionsApi.getByWorkspace);
const vibeReview = vi.mocked(sessionsApi.vibeReview);

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

describe('mobile workspace view actions', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: true })),
    });
    useUiPreferencesStore.setState({ mobileActiveTab: 'chat' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [Actions.ToggleLeftSidebar, 'workspaces'],
    [Actions.ToggleRightSidebar, 'git'],
    [Actions.ToggleChangesMode, 'changes'],
    [Actions.ToggleLogsMode, 'logs'],
    [Actions.TogglePreviewMode, 'preview'],
  ] as const)('$id switches its mobile tab back to chat', (action, tab) => {
    action.execute({} as ActionExecutorContext);
    expect(useUiPreferencesStore.getState().mobileActiveTab).toBe(tab);

    action.execute({} as ActionExecutorContext);
    expect(useUiPreferencesStore.getState().mobileActiveTab).toBe('chat');
  });

  it('always switches the chat panel action to chat', () => {
    useUiPreferencesStore.setState({ mobileActiveTab: 'preview' });

    Actions.ToggleLeftMainPanel.execute({} as ActionExecutorContext);

    expect(useUiPreferencesStore.getState().mobileActiveTab).toBe('chat');
  });
});

describe('command palette navigation actions', () => {
  const openWorkspaceContext = {
    layoutMode: 'kanban',
    hasWorkspace: true,
    isInPlace: false,
  } as ActionVisibilityContext;

  it('only shows open workspace for an open workspace on a project', () => {
    expect(isActionVisible(Actions.OpenWorkspace, openWorkspaceContext)).toBe(
      true
    );
    expect(
      isActionVisible(Actions.OpenWorkspace, {
        ...openWorkspaceContext,
        layoutMode: 'workspaces',
      })
    ).toBe(false);
  });

  it('shows open workspace in new tab on project and workspace screens', () => {
    expect(
      isActionVisible(Actions.OpenWorkspaceInNewTab, openWorkspaceContext)
    ).toBe(true);
    expect(
      isActionVisible(Actions.OpenWorkspaceInNewTab, {
        ...openWorkspaceContext,
        layoutMode: 'workspaces',
      })
    ).toBe(true);
    expect(
      isActionVisible(Actions.OpenWorkspaceInNewTab, {
        ...openWorkspaceContext,
        hasWorkspace: false,
      })
    ).toBe(false);
  });

  it('opens the project workspace in the workspace view', () => {
    const goToWorkspace = vi.fn();
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        currentHostId: 'host-1',
        appNavigation: { goToWorkspace } as never,
      }
    );

    Actions.OpenWorkspace.execute(ctx, 'ws1');

    expect(goToWorkspace).toHaveBeenCalledWith('ws1', { hostId: 'host-1' });
  });

  it('opens the project workspace in a new split pane', () => {
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        currentHostId: 'host/id',
      }
    );

    Actions.OpenWorkspaceInNewTab.execute(ctx, 'workspace/id');

    expect(openWorkspaceInSplitPane).toHaveBeenCalledWith(
      '/hosts/host%2Fid/workspaces/workspace%2Fid'
    );
  });

  it.each([Actions.SearchWorkspaceList, Actions.SearchProjectIssues])(
    '$id waits for the command bar focus trap to close and keeps assigned focus',
    (action) => {
      expect(action.restoreFocusOnClose).toBe(false);
      expect(action.executeAfterClose).toBe(true);
    }
  );

  it.each([
    Actions.ViewWorkspaceSessions,
    Actions.NewSession,
    Actions.RenameSession,
    Actions.DeleteSession,
    Actions.ViewIssueWorkspaces,
  ])('$id is hidden when its remote executor cannot run it', (action) => {
    const base = {
      appRuntime: 'remote',
      hasWorkspace: true,
      isCurrentWorkspaceTarget: true,
      hasSelectedKanbanIssue: true,
      isInPlace: false,
    } as ActionVisibilityContext;

    expect(isActionVisible(action, base)).toBe(false);
    expect(isActionVisible(action, { ...base, appRuntime: 'local' })).toBe(
      true
    );
  });

  it.each([
    Actions.ViewWorkspaceSessions,
    Actions.NewSession,
    Actions.RenameSession,
    Actions.DeleteSession,
  ])('$id is hidden for another workspace row', (action) => {
    const ctx = {
      appRuntime: 'local',
      hasWorkspace: true,
      isCurrentWorkspaceTarget: false,
      isInPlace: false,
    } as ActionVisibilityContext;

    expect(isActionVisible(action, ctx)).toBe(false);
  });

  it('does not start a new session for a different workspace target', () => {
    const startNewSession = vi.fn();
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        currentHostId: 'host-1',
        currentWorkspaceId: 'ws1',
        startNewSession,
      }
    );

    expect(() => Actions.NewSession.execute(ctx, 'ws2', 'host-1')).toThrow(
      'currently open workspace'
    );
    expect(startNewSession).not.toHaveBeenCalled();
  });

  it('does not load sessions from a different host target', async () => {
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        currentHostId: 'host-1',
        currentWorkspaceId: 'ws1',
      }
    );

    await expect(
      Actions.ViewWorkspaceSessions.execute(ctx, 'ws1', 'host-2')
    ).rejects.toThrow('currently open workspace');
    expect(getSessionsByWorkspace).not.toHaveBeenCalled();
  });
});

describe('session command labels', () => {
  it('keeps an explicitly assigned session name', () => {
    expect(
      getSessionCommandLabel({
        name: 'Review follow-up',
        updated_at: '2026-07-23T01:23:00Z',
      })
    ).toBe('Review follow-up');
  });

  it('formats the session date and time when the name is missing', () => {
    const updatedAt = '2026-07-23T01:23:00Z';
    expect(getSessionCommandLabel({ name: null, updated_at: updatedAt })).toBe(
      formatDateShortWithTime(updatedAt)
    );
  });
});

describe('Actions.StartReview', () => {
  it('starts the same automated review flow as the composer review button', async () => {
    vibeReview.mockResolvedValue({ id: 'review-session' } as never);
    const selectSession = vi.fn();
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        currentHostId: 'current-host',
        currentSessionId: 'session-1',
        selectSession,
      }
    );

    await Actions.StartReview.execute(ctx, 'ws1');

    expect(vibeReview).toHaveBeenCalledWith('session-1', 'current-host');
    expect(selectSession).toHaveBeenCalledWith('review-session');
  });

  it('starts review from the target workspace when its row menu is used', async () => {
    getSessionsByWorkspace.mockResolvedValue([
      { id: 'target-session' },
    ] as never);
    vibeReview.mockResolvedValue({ id: 'review-session' } as never);
    const selectWorkspace = vi.fn();
    const selectSession = vi.fn();
    const { ctx } = makeCtx(
      { id: 'current-workspace' },
      {
        currentWorkspaceId: 'current-workspace',
        currentSessionId: 'current-session',
        selectWorkspace,
        selectSession,
      }
    );

    await Actions.StartReview.execute(ctx, 'target-workspace', 'remote-host');

    expect(getSessionsByWorkspace).toHaveBeenCalledWith(
      'target-workspace',
      'remote-host'
    );
    expect(vibeReview).toHaveBeenCalledWith('target-session', 'remote-host');
    expect(selectWorkspace).toHaveBeenCalledWith(
      'target-workspace',
      'remote-host'
    );
    expect(selectSession).toHaveBeenCalledWith('review-session');
  });
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

describe('diverged push recovery', () => {
  const diverged = {
    success: false,
    message: null,
    error: { type: 'diverged', ahead: 2, behind: 3 },
  } as never;

  it('routes command-bar work-branch pushes through pull-first', async () => {
    push.mockResolvedValue(diverged);
    showPullFirst.mockResolvedValue('canceled');
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitPush.execute(ctx, 'ws1', 'repo1');

    expect(showPullFirst).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      repoId: 'repo1',
      ahead: 2,
      behind: 3,
    });
    expect(showForcePush).not.toHaveBeenCalled();
  });

  it('requires a second destructive confirmation for target force-push fallback', async () => {
    pushTargetBranch.mockResolvedValueOnce(diverged).mockResolvedValueOnce({
      success: true,
      data: { target_branch: 'main', remote: 'origin' },
    } as never);
    showPullFirst.mockResolvedValue('force');
    showConfirm.mockResolvedValue('confirmed');
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitPushTarget.execute(ctx, 'ws1', 'repo1');

    expect(showPullFirst).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      repoId: 'repo1',
      ahead: 2,
      behind: 3,
      isTarget: true,
    });
    expect(showConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive' })
    );
    expect(pushTargetBranch).toHaveBeenLastCalledWith('ws1', 'repo1', true);
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

describe('Actions.GitOpenPR', () => {
  it('is visible only when an open PR is connected', () => {
    expect(
      Actions.GitOpenPR.isVisible?.({
        hasWorkspace: true,
        hasGitRepos: true,
        hasOpenPR: true,
      } as ActionExecutorContext)
    ).toBe(true);
    expect(
      Actions.GitOpenPR.isVisible?.({
        hasWorkspace: true,
        hasGitRepos: true,
        hasOpenPR: false,
      } as ActionExecutorContext)
    ).toBe(false);
  });

  it('opens the connected PR for the selected repository', async () => {
    const reservedWindow = { close: vi.fn() } as unknown as Window;
    reservePrWindow.mockReturnValue(reservedWindow);
    openPrUrl.mockReturnValue(true);
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            pr_info: {
              status: 'open',
              url: 'https://example.com/pull/42',
            },
          },
        ],
      },
    ] as never);
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitOpenPR.execute(ctx, 'ws1', 'repo1');

    expect(reservePrWindow).toHaveBeenCalledOnce();
    expect(openPrUrl).toHaveBeenCalledWith(
      'https://example.com/pull/42',
      reservedWindow
    );
    expect(reservedWindow.close).not.toHaveBeenCalled();
  });

  it('closes the reserved window and explains when the selected repository has no open PR', async () => {
    const reservedWindow = { close: vi.fn() } as unknown as Window;
    reservePrWindow.mockReturnValue(reservedWindow);
    getBranchStatus.mockResolvedValue([
      { repo_id: 'repo1', merges: [] },
      {
        repo_id: 'repo2',
        merges: [
          {
            type: 'pr',
            pr_info: {
              status: 'open',
              url: 'https://example.com/pull/42',
            },
          },
        ],
      },
    ] as never);
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitOpenPR.execute(ctx, 'ws1', 'repo1');

    expect(reservedWindow.close).toHaveBeenCalledOnce();
    expect(openPrUrl).not.toHaveBeenCalled();
    expect(showConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'No Open Pull Request' })
    );
  });

  it('closes the reserved window when branch status loading fails', async () => {
    const reservedWindow = { close: vi.fn() } as unknown as Window;
    reservePrWindow.mockReturnValue(reservedWindow);
    getBranchStatus.mockRejectedValue(new Error('status failed'));
    const { ctx } = makeCtx({ id: 'ws1' });

    await expect(
      Actions.GitOpenPR.execute(ctx, 'ws1', 'repo1')
    ).rejects.toThrow('status failed');

    expect(reservedWindow.close).toHaveBeenCalledOnce();
    expect(openPrUrl).not.toHaveBeenCalled();
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
