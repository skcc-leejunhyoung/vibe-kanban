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
  scratchApi: { update: vi.fn() },
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
    pull: vi.fn(),
    pullTargetBranch: vi.fn(),
    push: vi.fn(),
    pushTargetBranch: vi.fn(),
    attachPr: vi.fn(),
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
  listGithubIssueLinksForIssue: vi.fn(),
}));
vi.mock('@vibe/ui/components/ConfirmDialog', () => ({
  ConfirmDialog: {
    show: vi.fn(),
  },
}));
vi.mock('@/shared/dialogs/command-bar/PullFirstDialog', () => ({
  PullFirstDialog: { show: vi.fn() },
}));
vi.mock('@/shared/dialogs/command-bar/ReconcileRemoteBranchDialog', () => ({
  ReconcileRemoteBranchDialog: { show: vi.fn() },
}));
vi.mock('@/shared/dialogs/command-bar/ForcePushDialog', () => ({
  ForcePushDialog: { show: vi.fn() },
}));
vi.mock('@vibe/ui/lib/open-url', () => ({
  openExternalUrl: vi.fn(),
  reserveExternalWindow: vi.fn(),
}));
vi.mock('@/shared/lib/openInSplitPane', () => ({
  openUrlInSplitPane: vi.fn(),
}));
vi.mock('@/shared/lib/reviewAndCreatePr', () => ({
  runReviewAndCreatePr: vi.fn(),
}));
vi.mock('@/shared/dialogs/tasks/PrDetailsDialog', () => ({
  PrDetailsDialog: { show: vi.fn() },
}));
vi.mock('@/shared/dialogs/command-bar/SelectionDialog', () => ({
  SelectionDialog: { show: vi.fn() },
}));
vi.mock('@/shared/dialogs/command-bar/LinkPrByUrlDialog', () => ({
  LinkPrByUrlDialog: { show: vi.fn() },
}));

import {
  Actions,
  getLinkedWorkspaceDescription,
  getSessionCommandLabel,
} from './index';
import { formatDateShortWithTime } from '@/shared/lib/date';
import { scratchApi, sessionsApi, workspacesApi } from '@/shared/lib/api';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { PullFirstDialog } from '@/shared/dialogs/command-bar/PullFirstDialog';
import { ReconcileRemoteBranchDialog } from '@/shared/dialogs/command-bar/ReconcileRemoteBranchDialog';
import { ForcePushDialog } from '@/shared/dialogs/command-bar/ForcePushDialog';
import { openExternalUrl, reserveExternalWindow } from '@vibe/ui/lib/open-url';
import { openUrlInSplitPane } from '@/shared/lib/openInSplitPane';
import { PrDetailsDialog } from '@/shared/dialogs/tasks/PrDetailsDialog';
import { SelectionDialog } from '@/shared/dialogs/command-bar/SelectionDialog';
import { LinkPrByUrlDialog } from '@/shared/dialogs/command-bar/LinkPrByUrlDialog';
import { getPageActions } from '@/shared/command-bar/actions/pages';
import { runReviewAndCreatePr } from '@/shared/lib/reviewAndCreatePr';
import { listGithubIssueLinksForIssue } from '@/shared/lib/remoteApi';

const update = vi.mocked(workspacesApi.update);
const updateScratch = vi.mocked(scratchApi.update);
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
const showReconcileRemote = vi.mocked(ReconcileRemoteBranchDialog.show);
const showForcePush = vi.mocked(ForcePushDialog.show);
const openPrUrl = vi.mocked(openExternalUrl);
const reservePrWindow = vi.mocked(reserveExternalWindow);
const openWorkspaceInSplitPane = vi.mocked(openUrlInSplitPane);
const getSessionsByWorkspace = vi.mocked(sessionsApi.getByWorkspace);
const vibeReview = vi.mocked(sessionsApi.vibeReview);
const showPrDetails = vi.mocked(PrDetailsDialog.show);
const showSelection = vi.mocked(SelectionDialog.show);
const showLinkPrByUrl = vi.mocked(LinkPrByUrlDialog.show);
const attachPr = vi.mocked(workspacesApi.attachPr);
const reviewAndCreatePr = vi.mocked(runReviewAndCreatePr);
const listGithubLinks = vi.mocked(listGithubIssueLinksForIssue);

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
    archivedWorkspaces: [],
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

  it('keeps pull request linking visible when the workspace has an open PR', () => {
    expect(
      isActionVisible(Actions.GitLinkPR, {
        ...openWorkspaceContext,
        hasGitRepos: true,
        hasOpenPR: true,
      })
    ).toBe(true);
  });

  it('allows both pull request link actions in quick chat', () => {
    const quickChatContext = {
      ...openWorkspaceContext,
      hasGitRepos: true,
      isInPlace: true,
    };

    expect(isActionVisible(Actions.GitLinkPR, quickChatContext)).toBe(true);
    expect(isActionVisible(Actions.GitLinkPRByUrl, quickChatContext)).toBe(
      true
    );
    expect(getPageActions('repoActions')).toContain(Actions.GitLinkPRByUrl);
  });

  it('links a pull request by URL without listing branch matches', async () => {
    showLinkPrByUrl.mockResolvedValue('https://github.com/acme/repo/pull/42');
    attachPr.mockResolvedValue({
      success: true,
      data: {
        pr_attached: true,
        pr_url: 'https://github.com/acme/repo/pull/42',
        pr_number: 42n,
        pr_status: 'open',
      },
    });
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitLinkPRByUrl.execute(ctx, 'ws1', 'repo1');

    expect(attachPr).toHaveBeenCalledWith('ws1', {
      repo_id: 'repo1',
      head_branch: null,
      pr_url: 'https://github.com/acme/repo/pull/42',
    });
  });

  it('exposes pull request linking from issue actions and targets one issue', async () => {
    const linkPullRequest = vi.fn();
    const { ctx } = makeCtx(
      {},
      { projectMutations: { linkPullRequest } as never }
    );

    expect(getPageActions('issueActions')).toContain(Actions.LinkPullRequest);
    expect(
      isActionVisible(Actions.LinkPullRequest, {
        ...openWorkspaceContext,
        hasSelectedKanbanIssue: true,
      })
    ).toBe(true);

    await Actions.LinkPullRequest.execute(ctx, 'project-1', ['issue-1']);
    expect(linkPullRequest).toHaveBeenCalledWith('issue-1');
  });

  it('exposes GitHub issue linking from issue actions and targets one issue', async () => {
    const linkGithubIssue = vi.fn();
    const { ctx } = makeCtx(
      {},
      { projectMutations: { linkGithubIssue } as never }
    );

    expect(getPageActions('issueActions')).toContain(Actions.LinkGithubIssue);
    expect(
      isActionVisible(Actions.LinkGithubIssue, {
        ...openWorkspaceContext,
        hasSelectedKanbanIssue: true,
      })
    ).toBe(true);

    await Actions.LinkGithubIssue.execute(ctx, 'project-1', ['issue-1']);
    expect(linkGithubIssue).toHaveBeenCalledWith('issue-1');
  });

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

  it('shows go to mapped issue for a local workspace target', () => {
    expect(
      isActionVisible(Actions.GotoWorkspaceMappedIssue, {
        ...openWorkspaceContext,
        appRuntime: 'local',
        layoutMode: 'workspaces',
      })
    ).toBe(true);
    expect(
      isActionVisible(Actions.GotoWorkspaceMappedIssue, {
        ...openWorkspaceContext,
        appRuntime: 'remote',
      })
    ).toBe(false);
    expect(
      isActionVisible(Actions.GotoWorkspaceMappedIssue, {
        ...openWorkspaceContext,
        appRuntime: 'local',
        hasWorkspace: false,
      })
    ).toBe(false);
  });

  it('navigates to the mapped issue of the target workspace', () => {
    const goToProjectIssue = vi.fn();
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        currentHostId: 'host-1',
        appNavigation: { goToProjectIssue } as never,
        remoteWorkspaces: [
          {
            id: 'remote-ws1',
            local_workspace_id: 'ws1',
            host_id: 'host-1',
            project_id: 'project-1',
            issue_id: 'issue-1',
          },
        ] as never,
      }
    );

    Actions.GotoWorkspaceMappedIssue.execute(ctx, 'ws1', 'host-1');

    expect(goToProjectIssue).toHaveBeenCalledWith('project-1', 'issue-1');
  });

  it('does not navigate when the target workspace has no mapped issue', () => {
    const goToProjectIssue = vi.fn();
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        currentHostId: 'host-1',
        appNavigation: { goToProjectIssue } as never,
        remoteWorkspaces: [
          {
            id: 'remote-ws1',
            local_workspace_id: 'ws1',
            host_id: 'host-1',
            project_id: 'project-1',
            issue_id: null,
          },
        ] as never,
      }
    );

    Actions.GotoWorkspaceMappedIssue.execute(ctx, 'ws1', 'host-1');

    expect(goToProjectIssue).not.toHaveBeenCalled();
  });

  it('only shows pull request repository selection on the pull requests page', () => {
    expect(
      isActionVisible(Actions.SelectPullRequestsRepository, {
        ...openWorkspaceContext,
        layoutMode: 'pull-requests',
      })
    ).toBe(true);
    expect(
      isActionVisible(
        Actions.SelectPullRequestsRepository,
        openWorkspaceContext
      )
    ).toBe(false);
  });

  it('exposes Open PR in Web in the palette only on the pull requests page', () => {
    expect(getPageActions('root')).toContain(Actions.OpenPullRequestInWeb);
    expect(
      isActionVisible(Actions.OpenPullRequestInWeb, {
        ...openWorkspaceContext,
        layoutMode: 'pull-requests',
      })
    ).toBe(true);
    expect(
      isActionVisible(Actions.OpenPullRequestInWeb, openWorkspaceContext)
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

    expect(openWorkspaceInSplitPane.mock.calls[0]?.[0]).toBe(
      '/hosts/host%2Fid/workspaces/workspace%2Fid'
    );
    expect(Actions.OpenWorkspaceInNewTab.restoreFocusOnClose).toBe(false);
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

describe('linked workspace descriptions', () => {
  it('shows active state with the latest process activity', () => {
    const completedAt = '2026-07-23T01:23:00Z';
    const startedAt = '2026-07-23T02:34:00Z';

    expect(
      getLinkedWorkspaceDescription(
        {
          isArchived: false,
          updatedAt: '2026-07-20T00:00:00Z',
          latestProcessStartedAt: startedAt,
          latestProcessCompletedAt: completedAt,
        },
        { archived: true, updatedAt: '2026-07-19T00:00:00Z' }
      )
    ).toBe(`Active · ${formatDateShortWithTime(startedAt)}`);
  });

  it('falls back to remote metadata for an archived workspace', () => {
    const updatedAt = '2026-07-22T03:45:00Z';

    expect(
      getLinkedWorkspaceDescription(undefined, {
        archived: true,
        updatedAt,
      })
    ).toBe(`Archived · ${formatDateShortWithTime(updatedAt)}`);
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

describe('Actions.StartReviewAndCreatePR', () => {
  it('runs the shared workflow for the current workspace and selects its review session', async () => {
    reviewAndCreatePr.mockImplementation(async ({ onReviewSession }) => {
      onReviewSession?.('review-session');
      return true;
    });
    const selectSession = vi.fn();
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        currentHostId: 'current-host',
        currentSessionId: 'session-1',
        selectSession,
      }
    );

    await Actions.StartReviewAndCreatePR.execute(ctx, 'ws1');

    expect(reviewAndCreatePr).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      sessionId: 'session-1',
      hostId: 'current-host',
      queryClient: ctx.queryClient,
      onReviewSession: expect.any(Function),
    });
    expect(selectSession).toHaveBeenCalledWith('review-session');
  });

  it('resolves a remote workspace session and preserves its host scope', async () => {
    getSessionsByWorkspace.mockResolvedValue([
      { id: 'target-session' },
    ] as never);
    reviewAndCreatePr.mockImplementation(async ({ onReviewSession }) => {
      onReviewSession?.('review-session');
      return true;
    });
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

    await Actions.StartReviewAndCreatePR.execute(
      ctx,
      'target-workspace',
      'remote-host'
    );

    expect(getSessionsByWorkspace).toHaveBeenCalledWith(
      'target-workspace',
      'remote-host'
    );
    expect(reviewAndCreatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'target-workspace',
        sessionId: 'target-session',
        hostId: 'remote-host',
      })
    );
    expect(selectWorkspace).toHaveBeenCalledWith(
      'target-workspace',
      'remote-host'
    );
    expect(selectSession).toHaveBeenCalledWith('review-session');
  });

  it('does not reuse the current session when the same workspace id is selected on another host', async () => {
    getSessionsByWorkspace.mockResolvedValue([
      { id: 'remote-session' },
    ] as never);
    reviewAndCreatePr.mockResolvedValue(true);
    const { ctx } = makeCtx(
      { id: 'shared-workspace-id' },
      {
        currentWorkspaceId: 'shared-workspace-id',
        currentHostId: 'local-host',
        currentSessionId: 'local-session',
      }
    );

    await Actions.StartReviewAndCreatePR.execute(
      ctx,
      'shared-workspace-id',
      'remote-host'
    );

    expect(getSessionsByWorkspace).toHaveBeenCalledWith(
      'shared-workspace-id',
      'remote-host'
    );
    expect(reviewAndCreatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'remote-session',
        hostId: 'remote-host',
      })
    );
  });

  it('is registered on the workspace command palette page', () => {
    expect(getPageActions('workspaceActions')).toContain(
      Actions.StartReviewAndCreatePR
    );
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

describe('Actions.NewWorkspace', () => {
  it('opens workspace creation in the project panel when invoked from a project', async () => {
    const goToProjectWorkspaceCreate = vi.fn();
    const { ctx } = makeCtx(
      {},
      {
        appRuntime: 'local',
        userId: null,
        kanbanProjectId: 'project-1',
        appNavigation: { goToProjectWorkspaceCreate } as never,
      }
    );

    await Actions.NewWorkspace.execute(ctx);

    expect(goToProjectWorkspaceCreate).toHaveBeenCalledWith(
      'project-1',
      expect.any(String),
      { hostId: undefined }
    );
  });

  it('persists a local project draft on the current remote host', async () => {
    const goToProjectWorkspaceCreate = vi.fn();
    const { ctx } = makeCtx(
      {},
      {
        appRuntime: 'local',
        userId: null,
        currentHostId: 'host-2',
        kanbanProjectId: 'project-1',
        appNavigation: { goToProjectWorkspaceCreate } as never,
      }
    );

    await Actions.NewWorkspace.execute(ctx);

    expect(updateScratch).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      'host-2'
    );
    expect(goToProjectWorkspaceCreate).toHaveBeenCalledWith(
      'project-1',
      expect.any(String),
      { hostId: 'host-2' }
    );
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

  it('routes command-bar work-branch pushes to local reconciliation without pushing again', async () => {
    push.mockResolvedValue(diverged);
    showReconcileRemote.mockResolvedValue('canceled');
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitPush.execute(ctx, 'ws1', 'repo1');

    expect(showReconcileRemote).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      repoId: 'repo1',
      ahead: 2,
      behind: 3,
      triggeredByPush: true,
    });
    expect(push).toHaveBeenCalledTimes(1);
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

describe('diverged pull recovery', () => {
  it('opens local reconciliation from Pull instead of suggesting a target rebase', async () => {
    vi.mocked(workspacesApi.pull).mockResolvedValue({
      type: 'diverged',
      ahead: 2,
      behind: 3,
    });
    showReconcileRemote.mockResolvedValue('canceled');
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitPull.execute(ctx, 'ws1', 'repo1');

    expect(showReconcileRemote).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      repoId: 'repo1',
      ahead: 2,
      behind: 3,
    });
    expect(showPullFirst).not.toHaveBeenCalled();
  });

  it('opens target reconciliation when Pull target branch detects a force-push divergence', async () => {
    vi.mocked(workspacesApi.pullTargetBranch).mockResolvedValue({
      type: 'diverged',
      ahead: 4,
      behind: 1,
    });
    showReconcileRemote.mockResolvedValue('canceled');
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitFetchTarget.execute(ctx, 'ws1', 'repo1');

    expect(showReconcileRemote).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      repoId: 'repo1',
      ahead: 4,
      behind: 1,
      isTarget: true,
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

  it('prompts for a selection when several open PRs are connected', async () => {
    const reservedWindow = { close: vi.fn() } as unknown as Window;
    reservePrWindow.mockReturnValue(reservedWindow);
    openPrUrl.mockReturnValue(true);
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            pr_info: { status: 'open', url: 'https://example.com/pull/41' },
          },
          {
            type: 'pr',
            pr_info: { status: 'open', url: 'https://example.com/pull/42' },
          },
        ],
      },
    ] as never);
    // The user picks the second open PR (index 1).
    showSelection.mockResolvedValue({ prIndex: 1 } as never);
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitOpenPR.execute(ctx, 'ws1', 'repo1');

    expect(showSelection).toHaveBeenCalledOnce();
    expect(openPrUrl).toHaveBeenCalledWith(
      'https://example.com/pull/42',
      reservedWindow
    );
  });

  it('ignores merged PRs and only offers open ones for selection', async () => {
    const reservedWindow = { close: vi.fn() } as unknown as Window;
    reservePrWindow.mockReturnValue(reservedWindow);
    openPrUrl.mockReturnValue(true);
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            pr_info: { status: 'merged', url: 'https://example.com/pull/40' },
          },
          {
            type: 'pr',
            pr_info: { status: 'open', url: 'https://example.com/pull/41' },
          },
        ],
      },
    ] as never);
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitOpenPR.execute(ctx, 'ws1', 'repo1');

    // Only one open PR remains after filtering, so no dialog is shown.
    expect(showSelection).not.toHaveBeenCalled();
    expect(openPrUrl).toHaveBeenCalledWith(
      'https://example.com/pull/41',
      reservedWindow
    );
  });

  it('closes the reserved window when the selection dialog is dismissed', async () => {
    const reservedWindow = { close: vi.fn() } as unknown as Window;
    reservePrWindow.mockReturnValue(reservedWindow);
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            pr_info: { status: 'open', url: 'https://example.com/pull/41' },
          },
          {
            type: 'pr',
            pr_info: { status: 'open', url: 'https://example.com/pull/42' },
          },
        ],
      },
    ] as never);
    showSelection.mockResolvedValue(undefined as never);
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitOpenPR.execute(ctx, 'ws1', 'repo1');

    expect(reservedWindow.close).toHaveBeenCalledOnce();
    expect(openPrUrl).not.toHaveBeenCalled();
    expect(showConfirm).not.toHaveBeenCalled();
  });
});

describe('Actions.GitViewPRDetails', () => {
  it('is visible when a merged or closed PR is connected', () => {
    expect(
      Actions.GitViewPRDetails.isVisible?.({
        hasWorkspace: true,
        hasGitRepos: true,
        hasLinkedPR: true,
        hasOpenPR: false,
      } as ActionExecutorContext)
    ).toBe(true);
  });

  it('opens merged PR details when the selected repository has no open PR', async () => {
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            pr_info: {
              number: 42,
              status: 'merged',
              url: 'https://example.com/pull/42',
            },
          },
        ],
      },
    ] as never);
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitViewPRDetails.execute(ctx, 'ws1', 'repo1');

    expect(showPrDetails).toHaveBeenCalledWith({
      prUrl: 'https://example.com/pull/42',
      prNumber: 42,
    });
  });

  it('prefers an open PR when multiple PRs are connected', async () => {
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            pr_info: {
              number: 41,
              status: 'merged',
              url: 'https://example.com/pull/41',
            },
          },
          {
            type: 'pr',
            pr_info: {
              number: 42,
              status: 'open',
              url: 'https://example.com/pull/42',
            },
          },
        ],
      },
    ] as never);
    const { ctx } = makeCtx({ id: 'ws1' });

    await Actions.GitViewPRDetails.execute(ctx, 'ws1', 'repo1');

    expect(showPrDetails).toHaveBeenCalledWith({
      prUrl: 'https://example.com/pull/42',
      prNumber: 42,
    });
  });
});

describe('Actions.GitOpenPRInPullRequests', () => {
  it('is visible when a PR is linked and the pull requests page is reachable', () => {
    expect(
      Actions.GitOpenPRInPullRequests.isVisible?.({
        hasWorkspace: true,
        hasGitRepos: true,
        hasLinkedPR: true,
        appRuntime: 'local',
        currentHostId: null,
      } as ActionExecutorContext)
    ).toBe(true);
  });

  it('is hidden on remote without a selected host', () => {
    expect(
      Actions.GitOpenPRInPullRequests.isVisible?.({
        hasWorkspace: true,
        hasGitRepos: true,
        hasLinkedPR: true,
        appRuntime: 'remote',
        currentHostId: null,
      } as ActionExecutorContext)
    ).toBe(false);
  });

  it('opens the only connected PR without prompting for a selection', async () => {
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            pr_info: {
              number: 42,
              status: 'merged',
              url: 'https://example.com/pull/42',
            },
          },
        ],
      },
    ] as never);
    const goToPullRequests = vi.fn();
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        appRuntime: 'local',
        currentHostId: null,
        appNavigation: { goToPullRequests } as never,
      }
    );

    await Actions.GitOpenPRInPullRequests.execute(ctx, 'ws1', 'repo1');

    expect(showSelection).not.toHaveBeenCalled();
    expect(goToPullRequests).toHaveBeenCalledWith(
      'https://example.com/pull/42',
      undefined
    );
  });

  it('prompts for a selection when several PRs are connected and opens the chosen one', async () => {
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            pr_info: {
              number: 41,
              status: 'open',
              url: 'https://example.com/pull/41',
            },
          },
          {
            type: 'pr',
            pr_info: {
              number: 42,
              status: 'merged',
              url: 'https://example.com/pull/42',
            },
          },
        ],
      },
    ] as never);
    // The user picks the second connected PR (index 1).
    showSelection.mockResolvedValue({ prIndex: 1 } as never);
    const goToPullRequests = vi.fn();
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        appRuntime: 'local',
        currentHostId: null,
        appNavigation: { goToPullRequests } as never,
      }
    );

    await Actions.GitOpenPRInPullRequests.execute(ctx, 'ws1', 'repo1');

    expect(showSelection).toHaveBeenCalledOnce();
    expect(goToPullRequests).toHaveBeenCalledWith(
      'https://example.com/pull/42',
      undefined
    );
  });

  it('does nothing when the selection dialog is dismissed', async () => {
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            pr_info: {
              number: 41,
              status: 'open',
              url: 'https://example.com/pull/41',
            },
          },
          {
            type: 'pr',
            pr_info: {
              number: 42,
              status: 'open',
              url: 'https://example.com/pull/42',
            },
          },
        ],
      },
    ] as never);
    showSelection.mockResolvedValue(undefined as never);
    const goToPullRequests = vi.fn();
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        appRuntime: 'local',
        currentHostId: null,
        appNavigation: { goToPullRequests } as never,
      }
    );

    await Actions.GitOpenPRInPullRequests.execute(ctx, 'ws1', 'repo1');

    expect(goToPullRequests).not.toHaveBeenCalled();
  });

  it('forwards the selected host when opening on remote', async () => {
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            pr_info: {
              number: 7,
              status: 'open',
              url: 'https://example.com/pull/7',
            },
          },
        ],
      },
    ] as never);
    const goToPullRequests = vi.fn();
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        appRuntime: 'remote',
        currentHostId: 'host-1',
        appNavigation: { goToPullRequests } as never,
      }
    );

    await Actions.GitOpenPRInPullRequests.execute(ctx, 'ws1', 'repo1');

    expect(goToPullRequests).toHaveBeenCalledWith(
      'https://example.com/pull/7',
      { hostId: 'host-1' }
    );
  });
});

describe('issue pull request actions', () => {
  const issueActionContext = {
    layoutMode: 'kanban',
    hasSelectedKanbanIssue: true,
  } as ActionVisibilityContext;

  const linkedPullRequest = {
    id: 'pr-1',
    number: 42,
    url: 'https://example.com/pull/42',
    status: 'open',
  };

  it('renames the workspace browser action and exposes its issue counterpart', () => {
    expect(Actions.GitOpenPR.label).toBe('Open PR in Web');
    expect(Actions.IssueOpenPRInWeb.isVisible?.(issueActionContext)).toBe(true);
    expect(getPageActions('issueActions')).toEqual(
      expect.arrayContaining([
        Actions.IssueOpenPRInWeb,
        Actions.IssueViewPRDetails,
      ])
    );
  });

  it('opens a pull request linked to the selected issue in the browser', async () => {
    const reservedWindow = { close: vi.fn() } as unknown as Window;
    reservePrWindow.mockReturnValue(reservedWindow);
    openPrUrl.mockReturnValue(true);
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        projectMutations: {
          removeIssue: vi.fn(),
          duplicateIssue: vi.fn(),
          getIssue: vi.fn(),
          getAssigneesForIssue: vi.fn(() => []),
          getPullRequestsForIssue: vi.fn(() => [linkedPullRequest]),
        },
      }
    );

    await Actions.IssueOpenPRInWeb.execute(ctx, 'project-1', ['issue-1']);

    expect(openPrUrl).toHaveBeenCalledWith(
      linkedPullRequest.url,
      reservedWindow
    );
  });

  it('opens the detail dialog for a pull request linked to the selected issue', async () => {
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        projectMutations: {
          removeIssue: vi.fn(),
          duplicateIssue: vi.fn(),
          getIssue: vi.fn(),
          getAssigneesForIssue: vi.fn(() => []),
          getPullRequestsForIssue: vi.fn(() => [linkedPullRequest]),
        },
      }
    );

    await Actions.IssueViewPRDetails.execute(ctx, 'project-1', ['issue-1']);

    expect(showPrDetails).toHaveBeenCalledWith({
      prUrl: linkedPullRequest.url,
      prNumber: linkedPullRequest.number,
    });
  });

  it('registers the pull requests page action for issues', () => {
    expect(
      Actions.IssueOpenPRInPullRequests.isVisible?.({
        ...issueActionContext,
        appRuntime: 'local',
        currentHostId: null,
      } as ActionVisibilityContext)
    ).toBe(true);
    expect(getPageActions('issueActions')).toEqual(
      expect.arrayContaining([Actions.IssueOpenPRInPullRequests])
    );
  });

  it('opens a pull request linked to the selected issue on the pull requests page', async () => {
    const goToPullRequests = vi.fn();
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        appRuntime: 'local',
        currentHostId: null,
        appNavigation: { goToPullRequests } as never,
        projectMutations: {
          removeIssue: vi.fn(),
          duplicateIssue: vi.fn(),
          getIssue: vi.fn(),
          getAssigneesForIssue: vi.fn(() => []),
          getPullRequestsForIssue: vi.fn(() => [linkedPullRequest]),
        },
      }
    );

    await Actions.IssueOpenPRInPullRequests.execute(ctx, 'project-1', [
      'issue-1',
    ]);

    expect(goToPullRequests).toHaveBeenCalledWith(
      linkedPullRequest.url,
      undefined
    );
  });
});

describe('GitHub issue in web actions', () => {
  const issueActionContext = {
    layoutMode: 'kanban',
    hasSelectedKanbanIssue: true,
  } as ActionVisibilityContext;

  const linkedGithubIssue = {
    id: 'gh-1',
    number: 7,
    url: 'https://github.com/acme/repo/issues/7',
  };

  it('exposes the issue counterpart on the issue actions page', () => {
    expect(
      Actions.IssueOpenGithubIssueInWeb.isVisible?.(issueActionContext)
    ).toBe(true);
    expect(getPageActions('issueActions')).toEqual(
      expect.arrayContaining([Actions.IssueOpenGithubIssueInWeb])
    );
  });

  it('opens the GitHub issue linked to the selected issue in the browser', async () => {
    const reservedWindow = { close: vi.fn() } as unknown as Window;
    reservePrWindow.mockReturnValue(reservedWindow);
    openPrUrl.mockReturnValue(true);
    const getGithubIssueLinkForIssue = vi.fn(() => linkedGithubIssue);
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        projectMutations: {
          removeIssue: vi.fn(),
          duplicateIssue: vi.fn(),
          getIssue: vi.fn(),
          getAssigneesForIssue: vi.fn(() => []),
          getPullRequestsForIssue: vi.fn(() => []),
          getGithubIssueLinkForIssue,
        },
      }
    );

    await Actions.IssueOpenGithubIssueInWeb.execute(ctx, 'project-1', [
      'issue-1',
    ]);

    expect(getGithubIssueLinkForIssue).toHaveBeenCalledWith('issue-1');
    expect(openPrUrl).toHaveBeenCalledWith(
      linkedGithubIssue.url,
      reservedWindow
    );
  });

  it('warns when the selected issue has no linked GitHub issue', async () => {
    reservePrWindow.mockReturnValue({ close: vi.fn() } as unknown as Window);
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        projectMutations: {
          removeIssue: vi.fn(),
          duplicateIssue: vi.fn(),
          getIssue: vi.fn(),
          getAssigneesForIssue: vi.fn(() => []),
          getPullRequestsForIssue: vi.fn(() => []),
          getGithubIssueLinkForIssue: vi.fn(() => undefined),
        },
      }
    );

    await Actions.IssueOpenGithubIssueInWeb.execute(ctx, 'project-1', [
      'issue-1',
    ]);

    expect(openPrUrl).not.toHaveBeenCalled();
    expect(showConfirm).toHaveBeenCalled();
  });

  it('shows the workspace counterpart for a workspace target', () => {
    expect(
      isActionVisible(Actions.WorkspaceOpenGithubIssueInWeb, {
        hasWorkspace: true,
      } as ActionVisibilityContext)
    ).toBe(true);
    expect(
      isActionVisible(Actions.WorkspaceOpenGithubIssueInWeb, {
        hasWorkspace: false,
      } as ActionVisibilityContext)
    ).toBe(false);
  });

  it('opens the GitHub issue mapped to the target workspace in the browser', async () => {
    const reservedWindow = { close: vi.fn() } as unknown as Window;
    reservePrWindow.mockReturnValue(reservedWindow);
    openPrUrl.mockReturnValue(true);
    listGithubLinks.mockResolvedValue([
      { url: 'https://github.com/acme/repo/issues/9', number: 9 },
    ] as never);
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        currentHostId: 'host-1',
        remoteWorkspaces: [
          {
            id: 'remote-ws1',
            local_workspace_id: 'ws1',
            host_id: 'host-1',
            project_id: 'project-1',
            issue_id: 'issue-1',
          },
        ] as never,
      }
    );

    await Actions.WorkspaceOpenGithubIssueInWeb.execute(ctx, 'ws1', 'host-1');

    expect(listGithubLinks).toHaveBeenCalledWith('issue-1');
    expect(openPrUrl).toHaveBeenCalledWith(
      'https://github.com/acme/repo/issues/9',
      reservedWindow
    );
  });

  it('warns and skips the fetch when the workspace has no mapped issue', async () => {
    const reservedWindow = { close: vi.fn() } as unknown as Window;
    reservePrWindow.mockReturnValue(reservedWindow);
    const { ctx } = makeCtx(
      { id: 'ws1' },
      {
        currentHostId: 'host-1',
        remoteWorkspaces: [
          {
            id: 'remote-ws1',
            local_workspace_id: 'ws1',
            host_id: 'host-1',
            project_id: 'project-1',
            issue_id: null,
          },
        ] as never,
      }
    );

    await Actions.WorkspaceOpenGithubIssueInWeb.execute(ctx, 'ws1', 'host-1');

    expect(listGithubLinks).not.toHaveBeenCalled();
    expect(openPrUrl).not.toHaveBeenCalled();
    expect(reservedWindow.close).toHaveBeenCalled();
    expect(showConfirm).toHaveBeenCalled();
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
