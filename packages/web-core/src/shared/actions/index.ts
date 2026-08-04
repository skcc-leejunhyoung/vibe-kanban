import { forwardRef, createElement } from 'react';
import type { Icon, IconProps } from '@phosphor-icons/react';
import type {
  ExecutorConfig,
  Merge,
  PullRequestDetail,
  RepoBranchStatus,
  Session,
  Workspace,
} from 'shared/types';
import type {
  PullRequest,
  Workspace as RemoteWorkspace,
} from 'shared/remote-types';
import type { QueryClient } from '@tanstack/react-query';
export { getLinkedWorkspaceDescription } from '@/shared/lib/linkedWorkspaceDescription';
import {
  CopyIcon,
  XIcon,
  PushPinIcon,
  ArchiveIcon,
  TrashIcon,
  PlusIcon,
  GearIcon,
  ColumnsIcon,
  RowsIcon,
  TextAlignLeftIcon,
  EyeSlashIcon,
  SidebarSimpleIcon,
  ChatsTeardropIcon,
  GitDiffIcon,
  TerminalIcon,
  SignInIcon,
  SignOutIcon,
  PlayIcon,
  PauseIcon,
  SpinnerIcon,
  GitPullRequestIcon,
  GitMergeIcon,
  GitCommitIcon,
  GitForkIcon,
  ArrowsClockwiseIcon,
  CrosshairIcon,
  DesktopIcon,
  PencilSimpleIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ArrowLineUpIcon,
  ArrowLineDownIcon,
  HighlighterIcon,
  ListIcon,
  QuestionIcon,
  ArrowsLeftRightIcon,
  ArrowFatLineUpIcon,
  UsersIcon,
  TreeStructureIcon,
  LinkIcon,
  LinkBreakIcon,
  ArrowBendUpRightIcon,
  ProhibitIcon,
  LightningIcon,
  LayoutIcon,
  KanbanIcon,
  MagnifyingGlassIcon,
  StackIcon,
  BellIcon,
  ArrowSquareOutIcon,
  ArrowsOutIcon,
  SparkleIcon,
  FunnelIcon,
} from '@phosphor-icons/react';
import { useDiffViewStore } from '@/shared/stores/useDiffViewStore';
import {
  useUiPreferencesStore,
  RIGHT_MAIN_PANEL_MODES,
} from '@/shared/stores/useUiPreferencesStore';
import { useProjectViewSwitcherStore } from '@/shared/stores/useProjectViewSwitcherStore';

import {
  workspacesApi,
  relayApi,
  repoApi,
  sessionsApi,
} from '@/shared/lib/api';
import { bulkUpdateIssues } from '@/shared/lib/remoteApi';
import { workspaceRecordKeys } from '@/shared/hooks/useWorkspaceRecord';
import { workspaceRepoKeys } from '@/shared/hooks/useWorkspaceRepo';
import { repoBranchKeys } from '@/shared/hooks/useRepoBranches';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { BranchPickerDialog } from '@/shared/dialogs/BranchPickerDialog';
import { DeleteWorkspaceDialog } from '@vibe/ui/components/DeleteWorkspaceDialog';
import { RebaseDialog } from '@/shared/dialogs/command-bar/RebaseDialog';
import { ResolveConflictsDialog } from '@/shared/dialogs/tasks/ResolveConflictsDialog';
import { RenameWorkspaceDialog } from '@vibe/ui/components/RenameWorkspaceDialog';
import { ProjectsGuideDialog } from '@vibe/ui/components/ProjectsGuideDialog';
import { CreatePRDialog } from '@/shared/dialogs/command-bar/CreatePRDialog';
import { usePrFromAiBackgroundStore } from '@/shared/stores/usePrFromAiBackgroundStore';
import { getIdeName } from '@/shared/lib/ideName';
import { EditorSelectionDialog } from '@/shared/dialogs/command-bar/EditorSelectionDialog';
import { StartReviewDialog } from '@/shared/dialogs/command-bar/StartReviewDialog';
import { PrDetailsDialog } from '@/shared/dialogs/tasks/PrDetailsDialog';
import {
  SelectionDialog,
  type SelectionPage,
} from '@/shared/dialogs/command-bar/SelectionDialog';
import { WorkspacesGuideDialog } from '@/shared/dialogs/shared/WorkspacesGuideDialog';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { CreateWorkspaceFromPrDialog } from '@/shared/dialogs/command-bar/CreateWorkspaceFromPrDialog';
import { QuickChatDialog } from '@/shared/dialogs/QuickChatDialog';
import { PullFirstDialog } from '@/shared/dialogs/command-bar/PullFirstDialog';
import { ReconcileRemoteBranchDialog } from '@/shared/dialogs/command-bar/ReconcileRemoteBranchDialog';
import { ForcePushDialog } from '@/shared/dialogs/command-bar/ForcePushDialog';
import { buildWorkspaceCreateInitialState } from '@/shared/lib/workspaceCreateState';
import { setCreateModeSeedState } from '@/features/create-mode/model/createModeSeedStore';
import { openExternalUrl, reserveExternalWindow } from '@vibe/ui/lib/open-url';
import { useAppBarVisibilityStore } from '@/shared/stores/useAppBarVisibilityStore';
import { RenameSessionDialog } from '@vibe/ui/components/RenameSessionDialog';
import { formatDateShortWithTime } from '@/shared/lib/date';
import {
  COMMAND_PALETTE_EVENT,
  dispatchCommandPaletteEvent,
} from '@/shared/lib/commandPaletteEvents';
import { openInSplitPane } from '@/shared/lib/openInSplitPane';
import { runReviewAndCreatePr } from '@/shared/lib/reviewAndCreatePr';
import { confirmUnpushedWorkBranchPush } from '@/shared/lib/unpushedWorkBranch';
import { buildWorkspacePath } from '@/shared/lib/routes/appNavigation';
import {
  PULL_REQUESTS_FOCUS_SEARCH_EVENT,
  PULL_REQUESTS_GOTO_MAPPED_ISSUE_EVENT,
  PULL_REQUESTS_OPEN_FILTERS_EVENT,
  PULL_REQUESTS_SELECT_REPOSITORY_EVENT,
  PULL_REQUESTS_VIEW_MAPPED_WORKSPACES_EVENT,
} from '@/pages/pull-requests/pullRequestFilters';

// Mirrored sidebar icon for right sidebar toggle
const RightSidebarIcon: Icon = forwardRef<SVGSVGElement, IconProps>(
  (props, ref) =>
    createElement(SidebarSimpleIcon, {
      ref,
      ...props,
      style: { transform: 'scaleX(-1)', ...props.style },
    })
);
RightSidebarIcon.displayName = 'RightSidebarIcon';

import type {
  ActionExecutorContext,
  ActionDefinition,
  GlobalActionDefinition,
  WorkspaceActionDefinition,
  IssueActionDefinition,
  NavbarItem,
} from '@/shared/types/actions';
import { ActionTargetType, NavbarDivider } from '@/shared/types/actions';
import { findRemoteWorkspaceByLocalIdentity } from '@/shared/lib/workspaceHostIdentity';

async function resolveLinkedIssue(
  workspaceId: string,
  hostId: string | null,
  remoteWorkspaces: {
    local_workspace_id: string | null;
    host_id: string | null;
    issue_id: string | null;
    project_id: string;
  }[]
): Promise<{ issueId: string; remoteProjectId: string } | undefined> {
  const remoteWs = findRemoteWorkspaceByLocalIdentity(
    remoteWorkspaces,
    workspaceId,
    hostId
  );
  if (remoteWs?.issue_id) {
    return { issueId: remoteWs.issue_id, remoteProjectId: remoteWs.project_id };
  }
  return undefined;
}

async function selectIssuePullRequest(
  ctx: ActionExecutorContext,
  issueIds: string[]
): Promise<PullRequest | undefined> {
  if (issueIds.length !== 1) {
    await ConfirmDialog.show({
      title: 'Select One Issue',
      message: 'Select a single issue to open one of its linked pull requests.',
      confirmText: 'OK',
      showCancelButton: false,
      variant: 'info',
    });
    return undefined;
  }

  const pullRequests =
    ctx.projectMutations?.getPullRequestsForIssue(issueIds[0]) ?? [];
  if (pullRequests.length === 0) {
    await ConfirmDialog.show({
      title: 'No Linked Pull Request',
      message: 'The selected issue does not have a linked pull request.',
      confirmText: 'OK',
      showCancelButton: false,
      variant: 'info',
    });
    return undefined;
  }

  if (pullRequests.length === 1) return pullRequests[0];

  const pages: Record<string, SelectionPage<{ pullRequestId: string }>> = {
    selectPullRequest: {
      id: 'selectPullRequest',
      title: 'Select Pull Request',
      buildGroups: () => [
        {
          label: 'Linked pull requests',
          items: pullRequests.map((pullRequest) => ({
            type: 'action' as const,
            action: {
              id: `select-pull-request-${pullRequest.id}`,
              label: `Pull Request #${pullRequest.number}`,
              description: pullRequest.status,
              icon: GitPullRequestIcon,
              requiresTarget: ActionTargetType.NONE,
              execute: () => {},
            } satisfies GlobalActionDefinition,
          })),
        },
      ],
      onSelect: (item) => {
        if (item.type !== 'action') {
          return { type: 'complete', data: undefined as never };
        }
        const pullRequestId = item.action.id.replace(
          'select-pull-request-',
          ''
        );
        return { type: 'complete', data: { pullRequestId } };
      },
    },
  };
  const result = await SelectionDialog.show({
    initialPageId: 'selectPullRequest',
    pages,
  });
  if (!result || typeof result !== 'object' || !('pullRequestId' in result)) {
    return undefined;
  }
  return pullRequests.find(
    (pullRequest) => pullRequest.id === result.pullRequestId
  );
}

async function getWorkspace(
  queryClient: QueryClient,
  workspaceId: string,
  hostId?: string | null
): Promise<Workspace> {
  const cached = queryClient.getQueryData<Workspace>(
    workspaceRecordKeys.byId(workspaceId, hostId ?? null)
  );
  if (cached) {
    return cached;
  }
  // Fetch from API if not in cache
  return workspacesApi.get(workspaceId, hostId);
}

export function getSessionCommandLabel(
  session: Pick<Session, 'name' | 'updated_at'>
): string {
  return session.name || formatDateShortWithTime(session.updated_at);
}

// Helper to invalidate workspace-related queries
function invalidateWorkspaceQueries(
  queryClient: QueryClient,
  workspaceId: string,
  hostId?: string | null
) {
  queryClient.invalidateQueries({
    queryKey: workspaceRecordKeys.byId(workspaceId, hostId ?? null),
  });
  queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
}

// Helper to find the next workspace to navigate to when removing current workspace
function getNextWorkspaceId(
  activeWorkspaces: { id: string; isRunning?: boolean }[],
  removingWorkspaceId: string
): string | null {
  const currentIndex = activeWorkspaces.findIndex(
    (ws) => ws.id === removingWorkspaceId
  );
  if (currentIndex >= 0 && activeWorkspaces.length > 1) {
    const nextWorkspace =
      activeWorkspaces[currentIndex + 1] || activeWorkspaces[currentIndex - 1];
    return nextWorkspace?.id ?? null;
  }
  return null;
}

function assertCurrentWorkspaceSessionTarget(
  ctx: ActionExecutorContext,
  workspaceId: string,
  hostId?: string | null
) {
  const targetsCurrentHost =
    hostId === undefined || hostId === ctx.currentHostId;
  if (workspaceId === ctx.currentWorkspaceId && targetsCurrentHost) return;

  throw new Error(
    'Session actions are only available for the currently open workspace.'
  );
}

// Helper to navigate to create-issue form for a sub-issue, carrying over parent assignees
function navigateToCreateSubIssue(
  ctx: ActionExecutorContext,
  parentIssueId: string
) {
  const assigneeIds = ctx.projectMutations
    ?.getAssigneesForIssue(parentIssueId)
    .map((a) => a.user_id);
  ctx.navigateToCreateIssue({
    statusId: ctx.defaultCreateStatusId,
    parentIssueId,
    assigneeIds: assigneeIds?.length ? assigneeIds : undefined,
  });
}

// Discover the feature branch a workspace's work branch was directly merged into
// for the given repo (the pivot of a three-branch workflow: work -> feature ->
// base via PR). Returns undefined when there's no such direct merge.
async function findMergedFeatureBranch(
  workspaceId: string,
  repoId: string
): Promise<string | undefined> {
  try {
    const branchStatus = await workspacesApi.getBranchStatus(workspaceId);
    const repoStatus = branchStatus.find((s) => s.repo_id === repoId);
    const directMerge = repoStatus?.merges?.find((m) => m.type === 'direct');
    return directMerge?.type === 'direct'
      ? directMerge.target_branch_name
      : undefined;
  } catch {
    return undefined;
  }
}

// The branch a workspace's work branch merges into for the given repo. A PR may
// originate from this target branch itself (e.g. an upstream `target -> base`
// PR), so it's a valid candidate when searching for a linkable PR.
async function findRepoTargetBranch(
  workspaceId: string,
  repoId: string
): Promise<string | undefined> {
  try {
    const branchStatus = await workspacesApi.getBranchStatus(workspaceId);
    const repoStatus = branchStatus.find((s) => s.repo_id === repoId);
    return repoStatus?.target_branch_name || undefined;
  } catch {
    return undefined;
  }
}

function isOpenPrFromWorkspaceBranch(
  merge: Merge,
  workspaceBranch: string
): boolean {
  return (
    merge.type === 'pr' &&
    merge.pr_info.status === 'open' &&
    (merge.head_branch_name ?? workspaceBranch) === workspaceBranch
  );
}

// All application actions
export const Actions = {
  // === Workspace Actions ===
  DuplicateWorkspace: {
    id: 'duplicate-workspace',
    label: 'Duplicate',
    icon: CopyIcon,
    shortcut: 'W D',
    requiresTarget: ActionTargetType.WORKSPACE,
    execute: async (ctx, workspaceId, hostId) => {
      try {
        const [firstMessage, repos, workspaceWithSession] = await Promise.all([
          workspacesApi.getFirstUserMessage(workspaceId, hostId),
          workspacesApi.getRepos(workspaceId, hostId),
          workspacesApi.getWithSession(workspaceId, hostId),
        ]);

        const linkedIssue = await resolveLinkedIssue(
          workspaceId,
          hostId ?? null,
          ctx.remoteWorkspaces
        );

        const executorConfig = workspaceWithSession.session?.executor
          ? {
              executor: workspaceWithSession.session
                .executor as ExecutorConfig['executor'],
            }
          : null;

        const createState = buildWorkspaceCreateInitialState({
          prompt: firstMessage,
          defaults: {
            preferredRepos: repos.map((r) => ({
              repo_id: r.id,
              target_branch: r.target_branch,
            })),
          },
          linkedIssue,
          executorConfig,
        });
        setCreateModeSeedState(createState);
        ctx.appNavigation.goToWorkspacesCreate({ hostId });
      } catch {
        ctx.appNavigation.goToWorkspacesCreate({ hostId });
      }
    },
  },

  RenameWorkspace: {
    id: 'rename-workspace',
    label: 'Rename',
    icon: PencilSimpleIcon,
    shortcut: 'W R',
    requiresTarget: ActionTargetType.WORKSPACE,
    execute: async (ctx, workspaceId, hostId) => {
      const workspace = await getWorkspace(
        ctx.queryClient,
        workspaceId,
        hostId
      );
      await RenameWorkspaceDialog.show({
        currentName: workspace.name || workspace.branch,
        onRename: async (newName) => {
          await workspacesApi.update(workspaceId, { name: newName }, hostId);
          invalidateWorkspaceQueries(ctx.queryClient, workspaceId, hostId);
        },
      });
    },
  },

  PinWorkspace: {
    id: 'pin-workspace',
    label: (workspace?: Workspace) => (workspace?.pinned ? 'Unpin' : 'Pin'),
    icon: PushPinIcon,
    shortcut: 'W P',
    requiresTarget: ActionTargetType.WORKSPACE,
    execute: async (ctx, workspaceId, hostId) => {
      const workspace = await getWorkspace(
        ctx.queryClient,
        workspaceId,
        hostId
      );
      await workspacesApi.update(
        workspaceId,
        {
          pinned: !workspace.pinned,
        },
        hostId
      );
      invalidateWorkspaceQueries(ctx.queryClient, workspaceId, hostId);
    },
  },

  ArchiveWorkspace: {
    id: 'archive-workspace',
    label: (workspace?: Workspace) =>
      workspace?.archived ? 'Unarchive' : 'Archive',
    icon: ArchiveIcon,
    shortcut: 'W A',
    requiresTarget: ActionTargetType.WORKSPACE,
    // Visible whenever a workspace is in context, matching its sibling
    // workspace actions (StartReview, SpinOffWorkspace). This keeps Archive in
    // the workspace three-dot menu even when a workspace is viewed inside the
    // kanban/project layout (the `project-issue-workspace` destination), where
    // `layoutMode` is 'kanban'.
    isVisible: (ctx) => ctx.hasWorkspace,
    isActive: (ctx) => ctx.workspaceArchived,
    execute: async (ctx, workspaceId, hostId) => {
      const workspace = await getWorkspace(
        ctx.queryClient,
        workspaceId,
        hostId
      );
      const wasArchived = workspace.archived;

      // Toggle the archive state without navigating anywhere. Archiving — from
      // the workspace list, the sidebar three-dot menu, or while the workspace
      // is open — must leave the current view in place; the workspace simply
      // moves between the active and Archived sections. (Previously this jumped
      // to a neighbouring workspace, which on mobile yanked the user into a
      // different workspace's screen.)
      await workspacesApi.update(
        workspaceId,
        { archived: !wasArchived },
        hostId
      );
      invalidateWorkspaceQueries(ctx.queryClient, workspaceId, hostId);
    },
  },

  DeleteWorkspace: {
    id: 'delete-workspace',
    label: 'Delete',
    icon: TrashIcon,
    shortcut: 'W X',
    variant: 'destructive',
    requiresTarget: ActionTargetType.WORKSPACE,
    execute: async (ctx, workspaceId, hostId) => {
      const workspace = await getWorkspace(
        ctx.queryClient,
        workspaceId,
        hostId
      );

      // Check if workspace is linked to a remote issue
      const remoteWs = findRemoteWorkspaceByLocalIdentity(
        ctx.remoteWorkspaces,
        workspaceId,
        hostId ?? null
      );
      const linkedIssueSimpleId = remoteWs?.issue_id
        ? ctx.projectMutations?.getIssue(remoteWs.issue_id)?.simple_id
        : undefined;
      // Branch status touches the source repos on disk, so it can fail when a repo
      // has been removed. Don't let that block deletion — fall back gracefully and
      // surface a warning instead.
      let branchStatus: RepoBranchStatus[] = [];
      let branchStatusFailed = false;
      try {
        branchStatus = await workspacesApi.getBranchStatus(workspaceId, hostId);
      } catch {
        branchStatusFailed = true;
      }
      const hasOpenPR = branchStatus.some((repoStatus) =>
        repoStatus.merges?.some(
          (m: Merge) => m.type === 'pr' && m.pr_info.status === 'open'
        )
      );
      const hasMissingRepo =
        branchStatusFailed || branchStatus.some((s) => s.repo_missing);

      const result = await DeleteWorkspaceDialog.show({
        branchName: workspace.branch,
        hasOpenPR,
        isLinkedToIssue: Boolean(remoteWs?.issue_id),
        linkedIssueSimpleId,
        hasMissingRepo,
        isInPlace: workspace.in_place,
      });
      if (result.action === 'confirmed') {
        // Calculate next workspace before deleting (only if deleting current)
        const isCurrentWorkspace = ctx.currentWorkspaceId === workspaceId;
        const nextWorkspaceId = isCurrentWorkspace
          ? getNextWorkspaceId(ctx.activeWorkspaces, workspaceId)
          : null;

        await workspacesApi.delete(workspaceId, result.deleteBranches, hostId);

        // Unlink from remote issue after successful deletion
        if (result.unlinkFromIssue) {
          await workspacesApi.unlinkFromIssue(workspaceId, hostId);
        }
        ctx.queryClient.invalidateQueries({
          queryKey: workspaceSummaryKeys.all,
        });

        // Navigate away if we deleted the current workspace
        if (isCurrentWorkspace) {
          if (nextWorkspaceId) {
            ctx.selectWorkspace(nextWorkspaceId);
          } else {
            ctx.appNavigation.goToWorkspacesCreate();
          }
        }
      }
    },
  },

  ViewWorkspaceSessions: {
    id: 'view-workspace-sessions',
    label: 'View sessions',
    icon: ChatsTeardropIcon,
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) =>
      ctx.appRuntime === 'local' && ctx.isCurrentWorkspaceTarget,
    execute: async (ctx, workspaceId, hostId) => {
      assertCurrentWorkspaceSessionTarget(ctx, workspaceId, hostId);
      const sessions = await sessionsApi.getByWorkspace(workspaceId, hostId);
      const { SelectionDialog } = await import(
        '@/shared/dialogs/command-bar/SelectionDialog'
      );
      const result = (await SelectionDialog.show({
        initialPageId: 'sessions',
        pages: {
          sessions: {
            id: 'sessions',
            title: 'Sessions',
            buildGroups: () => [
              {
                label: 'Sessions',
                items: sessions.map((session) => ({
                  type: 'action' as const,
                  action: {
                    id: `select-session-${session.id}`,
                    label: getSessionCommandLabel(session),
                    icon: ChatsTeardropIcon,
                    requiresTarget: ActionTargetType.NONE,
                    execute: () => {},
                  },
                })),
              },
            ],
            onSelect: (item) => ({
              type: 'complete' as const,
              data:
                item.type === 'action'
                  ? item.action.id.replace('select-session-', '')
                  : undefined,
            }),
          },
        },
      })) as string | undefined;
      if (result) ctx.selectSession(result);
    },
  },

  NewSession: {
    id: 'new-session',
    label: 'New session',
    icon: PlusIcon,
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) =>
      ctx.appRuntime === 'local' && ctx.isCurrentWorkspaceTarget,
    execute: (ctx, workspaceId, hostId) => {
      assertCurrentWorkspaceSessionTarget(ctx, workspaceId, hostId);
      ctx.startNewSession();
    },
  },

  RenameSession: {
    id: 'rename-session',
    label: 'Rename session',
    icon: PencilSimpleIcon,
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) =>
      ctx.appRuntime === 'local' && ctx.isCurrentWorkspaceTarget,
    execute: async (ctx, workspaceId, hostId) => {
      assertCurrentWorkspaceSessionTarget(ctx, workspaceId, hostId);
      if (!ctx.currentSessionId) return;
      const sessions = await sessionsApi.getByWorkspace(workspaceId, hostId);
      const session = sessions.find((item) => item.id === ctx.currentSessionId);
      if (!session) return;
      await RenameSessionDialog.show({
        currentName: session.name || 'Untitled session',
        onRename: async (name) => {
          await sessionsApi.update(session.id, { name }, hostId);
          await ctx.queryClient.invalidateQueries({
            queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
          });
        },
      });
    },
  },

  DeleteSession: {
    id: 'delete-session',
    label: 'Delete session',
    icon: TrashIcon,
    variant: 'destructive',
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) =>
      ctx.appRuntime === 'local' && ctx.isCurrentWorkspaceTarget,
    execute: async (ctx, workspaceId, hostId) => {
      assertCurrentWorkspaceSessionTarget(ctx, workspaceId, hostId);
      if (!ctx.currentSessionId) return;
      const result = await ConfirmDialog.show({
        title: 'Delete session',
        message: 'Delete this session and its conversation history?',
        confirmText: 'Delete',
        variant: 'destructive',
      });
      if (result !== 'confirmed') return;
      await sessionsApi.delete(ctx.currentSessionId, hostId);
      await ctx.queryClient.invalidateQueries({
        queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
      });
    },
  },

  StartReview: {
    id: 'start-review',
    label: 'Start Review',
    icon: GitPullRequestIcon,
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) => ctx.hasWorkspace,
    getTooltip: () => 'Start an automated review',
    execute: async (ctx, workspaceId, hostId) => {
      const isCurrentWorkspace = ctx.currentWorkspaceId === workspaceId;
      const targetHostId =
        hostId === undefined
          ? isCurrentWorkspace
            ? ctx.currentHostId
            : null
          : hostId;
      const targetSessionId = isCurrentWorkspace
        ? ctx.currentSessionId
        : (await sessionsApi.getByWorkspace(workspaceId, targetHostId))[0]?.id;
      if (!targetSessionId) {
        throw new Error('Select a chat session before starting a review');
      }
      const reviewSession = await sessionsApi.vibeReview(
        targetSessionId,
        targetHostId
      );
      await ctx.queryClient.invalidateQueries({
        queryKey: workspaceSessionKeys.byWorkspace(workspaceId, targetHostId),
      });
      if (!isCurrentWorkspace) {
        ctx.selectWorkspace(workspaceId, targetHostId);
      }
      ctx.selectSession(reviewSession.id);
    },
  },

  StartReviewAndCreatePR: {
    id: 'start-review-and-create-pr',
    label: 'Review and create PR from ai',
    icon: SparkleIcon,
    keywords: ['review', 'merge', 'push', 'pull request', 'ai', 'draft'],
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) => ctx.hasWorkspace,
    getTooltip: () => 'Review, merge, push target, and create an AI draft PR',
    execute: async (ctx, workspaceId, hostId) => {
      const isCurrentWorkspace =
        ctx.currentWorkspaceId === workspaceId &&
        (hostId === undefined || hostId === ctx.currentHostId);
      const targetHostId =
        hostId === undefined
          ? isCurrentWorkspace
            ? ctx.currentHostId
            : null
          : hostId;
      const targetSessionId = isCurrentWorkspace
        ? ctx.currentSessionId
        : (await sessionsApi.getByWorkspace(workspaceId, targetHostId))[0]?.id;
      if (!targetSessionId) {
        throw new Error('Select a chat session before starting a review');
      }

      await runReviewAndCreatePr({
        workspaceId,
        sessionId: targetSessionId,
        hostId: targetHostId,
        queryClient: ctx.queryClient,
        onReviewSession: (reviewSessionId) => {
          if (!isCurrentWorkspace) {
            ctx.selectWorkspace(workspaceId, targetHostId);
          }
          ctx.selectSession(reviewSessionId);
        },
      });
    },
  },

  AddReviewComments: {
    id: 'add-review-comments',
    label: 'Add Review Comments',
    icon: HighlighterIcon,
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) => ctx.hasWorkspace,
    getTooltip: () => 'Review changes with agent',
    execute: async (_ctx, workspaceId, hostId) => {
      await StartReviewDialog.show({
        workspaceId,
        hostId,
      });
    },
  },

  SpinOffWorkspace: {
    id: 'spin-off-workspace',
    label: 'Spin off workspace',
    icon: GitForkIcon,
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) => ctx.hasWorkspace,
    execute: async (ctx, workspaceId, hostId) => {
      try {
        const [workspace, repos] = await Promise.all([
          getWorkspace(ctx.queryClient, workspaceId, hostId),
          workspacesApi.getRepos(workspaceId, hostId),
        ]);
        const linkedIssue = await resolveLinkedIssue(
          workspaceId,
          hostId ?? null,
          ctx.remoteWorkspaces
        );

        const createState = buildWorkspaceCreateInitialState({
          prompt: null,
          defaults: {
            preferredRepos: repos.map((r) => ({
              repo_id: r.id,
              target_branch: workspace.branch,
            })),
          },
          linkedIssue,
        });
        setCreateModeSeedState(createState);
        ctx.appNavigation.goToWorkspacesCreate({ hostId });
      } catch {
        ctx.appNavigation.goToWorkspacesCreate({ hostId });
      }
    },
  },

  // === Global/Navigation Actions ===
  NewWorkspace: {
    id: 'new-workspace',
    label: 'New Workspace',
    icon: PlusIcon,
    shortcut: 'G N',
    requiresTarget: ActionTargetType.NONE,
    execute: async (ctx) => {
      if (ctx.appRuntime === 'remote') {
        const { selectWorkspaceHost } = await import(
          '@/shared/dialogs/command-bar/WorkspaceHostSelectionDialog'
        );
        const hostId = await selectWorkspaceHost();
        if (hostId === undefined) return;
        ctx.appNavigation.goToWorkspacesCreate({ hostId });
        return;
      }
      ctx.appNavigation.goToWorkspacesCreate();
    },
  },

  ToggleWorkspaceArchiveView: {
    id: 'toggle-workspace-archive-view',
    label: 'Toggle active / archived workspaces',
    icon: ArchiveIcon,
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'workspaces',
    execute: () =>
      dispatchCommandPaletteEvent(COMMAND_PALETTE_EVENT.toggleWorkspaceArchive),
  },

  SearchWorkspaceList: {
    id: 'search-workspace-list',
    label: 'Search workspaces',
    icon: MagnifyingGlassIcon,
    requiresTarget: ActionTargetType.NONE,
    restoreFocusOnClose: false,
    executeAfterClose: true,
    isVisible: (ctx) => ctx.layoutMode === 'workspaces',
    execute: () =>
      dispatchCommandPaletteEvent(COMMAND_PALETTE_EVENT.focusWorkspaceSearch),
  },

  SearchProjectIssues: {
    id: 'search-project-issues',
    label: 'Search project issues',
    icon: MagnifyingGlassIcon,
    requiresTarget: ActionTargetType.NONE,
    restoreFocusOnClose: false,
    executeAfterClose: true,
    isVisible: (ctx) => ctx.layoutMode === 'kanban',
    execute: () =>
      dispatchCommandPaletteEvent(COMMAND_PALETTE_EVENT.focusIssueSearch),
  },

  ViewIssueWorkspaces: {
    id: 'view-issue-workspaces',
    label: 'View linked workspaces',
    icon: StackIcon,
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.appRuntime === 'local' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, projectId, issueIds) => {
      const issueId = issueIds[0];
      if (!issueId) return;
      const workspaces = ctx.remoteWorkspaces.filter(
        (
          workspace
        ): workspace is RemoteWorkspace & { local_workspace_id: string } =>
          workspace.project_id === projectId &&
          workspace.issue_id === issueId &&
          workspace.local_workspace_id !== null
      );
      const workspaceSummaries = [
        ...ctx.activeWorkspaces,
        ...ctx.archivedWorkspaces,
      ];
      const { selectLinkedWorkspace } = await import(
        '@/shared/dialogs/command-bar/selectLinkedWorkspace'
      );
      const workspace = await selectLinkedWorkspace({
        title: 'Linked workspaces',
        workspaces,
        workspaceSummaries,
      });
      if (workspace) {
        ctx.appNavigation.goToProjectIssueWorkspace(
          projectId,
          issueId,
          workspace.local_workspace_id,
          { hostId: workspace.host_id }
        );
      }
    },
  },

  QuickChat: {
    id: 'quick-chat',
    label: 'Quick Chat',
    icon: LightningIcon,
    shortcut: 'G Q',
    keywords: ['quick chat', 'agent', 'folder', 'in place'],
    requiresTarget: ActionTargetType.NONE,
    execute: async () => {
      await QuickChatDialog.show();
    },
  } satisfies GlobalActionDefinition,

  CreateWorkspaceFromPR: {
    id: 'create-workspace-from-pr',
    label: 'Create Workspace from PR',
    icon: GitPullRequestIcon,
    keywords: ['pull request'],
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'workspaces',
    execute: async () => {
      await CreateWorkspaceFromPrDialog.show({});
    },
  } satisfies GlobalActionDefinition,

  Settings: {
    id: 'settings',
    label: 'Settings',
    icon: GearIcon,
    shortcut: 'G S',
    requiresTarget: ActionTargetType.NONE,
    execute: async () => {
      await SettingsDialog.show();
    },
  },

  ProjectSettings: {
    id: 'project-settings',
    label: 'Project Settings',
    icon: GearIcon,
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'kanban',
    execute: async (ctx) => {
      await SettingsDialog.show({
        initialSection: 'remote-projects',
        initialState: {
          organizationId: ctx.kanbanOrgId,
          projectId: ctx.kanbanProjectId,
        },
      });
    },
  } satisfies GlobalActionDefinition,

  SelectProjectView: {
    id: 'select-project-view',
    label: 'Select view',
    icon: KanbanIcon,
    keywords: [
      'view',
      'switch view',
      'select view',
      'active',
      'all',
      'backlog',
      'board',
      'table',
    ],
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'kanban',
    execute: async () => {
      const { projectId, views, activeViewId } =
        useProjectViewSwitcherStore.getState();
      if (!projectId || views.length === 0) return;
      const { SelectionDialog } = await import(
        '@/shared/dialogs/command-bar/SelectionDialog'
      );
      const { buildViewSelectionPages } = await import(
        '@/shared/dialogs/command-bar/selections/viewSelection'
      );
      const result = await SelectionDialog.show({
        initialPageId: 'selectView',
        pages: buildViewSelectionPages(views, activeViewId) as Record<
          string,
          import('@/shared/dialogs/command-bar/SelectionDialog').SelectionPage
        >,
      });
      if (result && typeof result === 'object' && 'viewId' in result) {
        useUiPreferencesStore
          .getState()
          .setKanbanProjectView(
            projectId,
            (result as { viewId: string }).viewId
          );
      }
    },
  } satisfies GlobalActionDefinition,

  SignIn: {
    id: 'sign-in',
    label: 'Sign In',
    icon: SignInIcon,
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => !ctx.isSignedIn,
    execute: async () => {
      const { OAuthDialog } = await import(
        '@/shared/dialogs/global/OAuthDialog'
      );
      await OAuthDialog.show({});
    },
  } satisfies GlobalActionDefinition,

  GotoWorkspaces: {
    id: 'goto-workspaces',
    label: 'Goto: Workspace',
    icon: LayoutIcon,
    keywords: ['workspace', 'workspaces', 'go to', 'navigate'],
    requiresTarget: ActionTargetType.NONE,
    execute: (ctx) => ctx.appNavigation.goToWorkspaces(),
  } satisfies GlobalActionDefinition,

  OpenWorkspace: {
    id: 'open-workspace',
    label: 'Open Workspace',
    icon: ArrowsOutIcon,
    keywords: ['workspace', 'open', 'navigate'],
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) => ctx.layoutMode === 'kanban' && ctx.hasWorkspace,
    execute: (ctx, workspaceId, hostId) => {
      ctx.appNavigation.goToWorkspace(workspaceId, {
        hostId: hostId === undefined ? ctx.currentHostId : hostId,
      });
    },
  } satisfies WorkspaceActionDefinition,

  OpenWorkspaceInNewTab: {
    id: 'open-workspace-in-new-tab',
    label: 'Open Workspace in New Tab',
    icon: ArrowSquareOutIcon,
    keywords: ['workspace', 'open', 'new tab'],
    requiresTarget: ActionTargetType.WORKSPACE,
    restoreFocusOnClose: false,
    isVisible: (ctx) => ctx.hasWorkspace,
    execute: (ctx, workspaceId, hostId) => {
      openInSplitPane(
        buildWorkspacePath(
          workspaceId,
          hostId === undefined ? ctx.currentHostId : hostId
        )
      );
    },
  } satisfies WorkspaceActionDefinition,

  GotoProjects: {
    id: 'goto-projects',
    label: 'Goto: Projects',
    icon: KanbanIcon,
    keywords: ['project', 'projects', 'go to', 'navigate'],
    requiresTarget: ActionTargetType.NONE,
    isEnabled: (ctx) => ctx.isSignedIn,
    execute: (ctx) => {
      const firstProject = ctx.navigationProjects[0];
      if (firstProject) ctx.appNavigation.goToProject(firstProject.id);
    },
  } satisfies GlobalActionDefinition,

  GotoNotifications: {
    id: 'goto-notifications',
    label: 'Goto: Notifications',
    icon: BellIcon,
    keywords: ['notification', 'notifications', 'alerts', 'go to', 'navigate'],
    requiresTarget: ActionTargetType.NONE,
    isEnabled: (ctx) => ctx.isSignedIn,
    execute: (ctx) => ctx.appNavigation.goToNotifications(),
  } satisfies GlobalActionDefinition,

  GotoPullRequests: {
    id: 'goto-pull-requests',
    label: 'Goto: Pull Requests',
    icon: GitPullRequestIcon,
    keywords: ['pull request', 'pr', 'go to', 'navigate'],
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) =>
      ctx.appRuntime === 'local' || ctx.currentHostId !== null,
    execute: (ctx) => {
      ctx.appNavigation.goToPullRequests();
    },
  } satisfies GlobalActionDefinition,

  FilterPullRequests: {
    id: 'filter-pull-requests',
    label: 'Pull Requests: Filters',
    icon: FunnelIcon,
    keywords: ['pull request', 'pr', 'filter'],
    requiresTarget: ActionTargetType.NONE,
    restoreFocusOnClose: false,
    executeAfterClose: true,
    isVisible: (ctx) => ctx.layoutMode === 'pull-requests',
    execute: () => {
      window.dispatchEvent(new Event(PULL_REQUESTS_OPEN_FILTERS_EVENT));
    },
  } satisfies GlobalActionDefinition,

  SelectPullRequestsRepository: {
    id: 'select-pull-requests-repository',
    label: 'Pull Requests: Select Repository',
    icon: GitForkIcon,
    keywords: ['pull request', 'pr', 'repository', 'repo', 'select'],
    requiresTarget: ActionTargetType.NONE,
    restoreFocusOnClose: false,
    executeAfterClose: true,
    isVisible: (ctx) => ctx.layoutMode === 'pull-requests',
    execute: async () => {
      const repos = await repoApi.list();
      if (repos.length === 0) return;
      const { buildRepoSelectionPages } = await import(
        '@/shared/dialogs/command-bar/selections/repoSelection'
      );
      const result = await SelectionDialog.show({
        initialPageId: 'selectRepo',
        pages: buildRepoSelectionPages(repos),
      });
      if (!result || typeof result !== 'object' || !('repoId' in result)) {
        return;
      }
      window.dispatchEvent(
        new CustomEvent(PULL_REQUESTS_SELECT_REPOSITORY_EVENT, {
          detail: { repoId: result.repoId },
        })
      );
    },
  } satisfies GlobalActionDefinition,

  SearchPullRequests: {
    id: 'search-pull-requests',
    label: 'Pull Requests: Search',
    icon: MagnifyingGlassIcon,
    keywords: ['pull request', 'pr', 'search', 'find'],
    requiresTarget: ActionTargetType.NONE,
    restoreFocusOnClose: false,
    executeAfterClose: true,
    isVisible: (ctx) => ctx.layoutMode === 'pull-requests',
    execute: () => {
      window.dispatchEvent(new Event(PULL_REQUESTS_FOCUS_SEARCH_EVENT));
    },
  } satisfies GlobalActionDefinition,

  GotoPullRequestMappedIssue: {
    id: 'goto-pull-request-mapped-issue',
    label: 'Pull Requests: Go to mapped issue',
    icon: ArrowSquareOutIcon,
    keywords: ['pull request', 'pr', 'issue', 'mapped', 'go to'],
    requiresTarget: ActionTargetType.NONE,
    restoreFocusOnClose: false,
    executeAfterClose: true,
    isVisible: (ctx) => ctx.layoutMode === 'pull-requests',
    execute: () => {
      window.dispatchEvent(new Event(PULL_REQUESTS_GOTO_MAPPED_ISSUE_EVENT));
    },
  } satisfies GlobalActionDefinition,

  ViewPullRequestMappedWorkspaces: {
    id: 'view-pull-request-mapped-workspaces',
    label: 'Pull Requests: View mapped workspaces',
    icon: StackIcon,
    keywords: ['pull request', 'pr', 'workspace', 'mapped', 'linked'],
    requiresTarget: ActionTargetType.NONE,
    restoreFocusOnClose: false,
    executeAfterClose: true,
    isVisible: (ctx) => ctx.layoutMode === 'pull-requests',
    execute: () => {
      window.dispatchEvent(
        new Event(PULL_REQUESTS_VIEW_MAPPED_WORKSPACES_EVENT)
      );
    },
  } satisfies GlobalActionDefinition,

  SignOut: {
    id: 'sign-out',
    label: 'Sign Out',
    icon: SignOutIcon,
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.isSignedIn,
    execute: async (ctx) => {
      const { oauthApi } = await import('@/shared/lib/api');
      const { useOrganizationStore } = await import(
        '@/shared/stores/useOrganizationStore'
      );
      const { organizationKeys } = await import(
        '@/shared/hooks/organizationKeys'
      );

      await oauthApi.logout();
      useOrganizationStore.getState().clearSelectedOrgId();
      ctx.queryClient.removeQueries({ queryKey: organizationKeys.all });
      // Invalidate user-system query to update loginStatus/useAuth state
      await ctx.queryClient.invalidateQueries({ queryKey: ['user-system'] });
      ctx.appNavigation.goToWorkspaces();
    },
  } satisfies GlobalActionDefinition,

  WorkspacesGuide: {
    id: 'workspaces-guide',
    label: 'Workspaces Guide',
    icon: QuestionIcon,
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'workspaces',
    execute: async () => {
      await WorkspacesGuideDialog.show();
    },
  },

  ProjectsGuide: {
    id: 'projects-guide',
    label: 'Projects Guide',
    icon: QuestionIcon,
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'kanban',
    execute: async () => {
      await ProjectsGuideDialog.show();
    },
  } satisfies GlobalActionDefinition,

  OpenCommandBar: {
    id: 'open-command-bar',
    label: 'Open Command Bar',
    icon: ListIcon,
    shortcut: '{mod} K',
    requiresTarget: ActionTargetType.NONE,
    execute: async () => {
      // Dynamic import to avoid circular dependency (pages.ts imports Actions)
      const { CommandBarDialog } = await import(
        '@/shared/dialogs/command-bar/CommandBarDialog'
      );
      CommandBarDialog.show();
    },
  },

  // === Diff View Actions ===
  ToggleDiffViewMode: {
    id: 'toggle-diff-view-mode',
    label: () =>
      useDiffViewStore.getState().mode === 'unified'
        ? 'Switch to Side-by-Side View'
        : 'Switch to Inline View',
    icon: ColumnsIcon,
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) =>
      ctx.rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES &&
      ctx.layoutMode === 'workspaces',
    isActive: (ctx) => ctx.diffViewMode === 'split',
    getIcon: (ctx) => (ctx.diffViewMode === 'split' ? ColumnsIcon : RowsIcon),
    getTooltip: (ctx) =>
      ctx.diffViewMode === 'split' ? 'Inline view' : 'Side-by-side view',
    execute: () => {
      useDiffViewStore.getState().toggle();
    },
  },

  ToggleIgnoreWhitespace: {
    id: 'toggle-ignore-whitespace',
    label: () =>
      useDiffViewStore.getState().ignoreWhitespace
        ? 'Show Whitespace Changes'
        : 'Ignore Whitespace Changes',
    icon: EyeSlashIcon,
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) =>
      ctx.rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES &&
      ctx.layoutMode === 'workspaces',
    execute: () => {
      const store = useDiffViewStore.getState();
      store.setIgnoreWhitespace(!store.ignoreWhitespace);
    },
  },

  ToggleWrapLines: {
    id: 'toggle-wrap-lines',
    label: () =>
      useDiffViewStore.getState().wrapText
        ? 'Disable Line Wrapping'
        : 'Enable Line Wrapping',
    icon: TextAlignLeftIcon,
    shortcut: 'T W',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) =>
      ctx.rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES &&
      ctx.layoutMode === 'workspaces',
    execute: () => {
      const store = useDiffViewStore.getState();
      store.setWrapText(!store.wrapText);
    },
  },

  // === Layout Panel Actions ===
  ToggleAppBar: {
    id: 'toggle-app-bar',
    label: () =>
      useAppBarVisibilityStore.getState().isVisible
        ? 'Hide App Bar'
        : 'Show App Bar',
    icon: SidebarSimpleIcon,
    requiresTarget: ActionTargetType.NONE,
    execute: () => {
      useAppBarVisibilityStore.getState().toggle();
    },
  },

  ToggleLeftSidebar: {
    id: 'toggle-left-sidebar',
    label: () =>
      useUiPreferencesStore.getState().isLeftSidebarVisible
        ? 'Hide Left Sidebar'
        : 'Show Left Sidebar',
    icon: SidebarSimpleIcon,
    shortcut: 'V S',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'workspaces',
    isActive: (ctx) => ctx.isLeftSidebarVisible,
    execute: () => {
      const store = useUiPreferencesStore.getState();
      if (window.matchMedia('(max-width: 767px)').matches) {
        store.setMobileActiveTab(
          store.mobileActiveTab === 'workspaces' ? 'chat' : 'workspaces'
        );
        return;
      }
      store.toggleLeftSidebar();
    },
  },

  ToggleLeftMainPanel: {
    id: 'toggle-left-main-panel',
    label: 'Toggle Chat Panel',
    icon: ChatsTeardropIcon,
    shortcut: 'V H',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'workspaces',
    isActive: (ctx) => ctx.isLeftMainPanelVisible,
    isEnabled: (ctx) =>
      !(ctx.isLeftMainPanelVisible && ctx.rightMainPanelMode === null),
    getLabel: (ctx) =>
      ctx.isLeftMainPanelVisible ? 'Hide Chat Panel' : 'Show Chat Panel',
    execute: (ctx) => {
      if (window.matchMedia('(max-width: 767px)').matches) {
        useUiPreferencesStore.getState().setMobileActiveTab('chat');
        return;
      }
      useUiPreferencesStore
        .getState()
        .toggleLeftMainPanel(ctx.currentWorkspaceId ?? undefined);
    },
  },

  ToggleRightSidebar: {
    id: 'toggle-right-sidebar',
    label: () =>
      useUiPreferencesStore.getState().isRightSidebarVisible
        ? 'Hide Right Sidebar'
        : 'Show Right Sidebar',
    icon: RightSidebarIcon,
    shortcut: 'V R',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'workspaces',
    isActive: (ctx) => ctx.isRightSidebarVisible,
    execute: () => {
      const store = useUiPreferencesStore.getState();
      if (window.matchMedia('(max-width: 767px)').matches) {
        store.setMobileActiveTab(
          store.mobileActiveTab === 'git' ? 'chat' : 'git'
        );
        return;
      }
      store.toggleRightSidebar();
    },
  },

  ToggleChangesMode: {
    id: 'toggle-changes-mode',
    label: 'Toggle Changes Panel',
    icon: GitDiffIcon,
    shortcut: 'V C',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => !ctx.isCreateMode && ctx.layoutMode === 'workspaces',
    isActive: (ctx) =>
      ctx.rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES,
    isEnabled: (ctx) => !ctx.isCreateMode,
    getLabel: (ctx) =>
      ctx.rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES
        ? 'Hide Changes Panel'
        : 'Show Changes Panel',
    execute: (ctx) => {
      if (window.matchMedia('(max-width: 767px)').matches) {
        const store = useUiPreferencesStore.getState();
        store.setMobileActiveTab(
          store.mobileActiveTab === 'changes' ? 'chat' : 'changes'
        );
        return;
      }
      useUiPreferencesStore
        .getState()
        .toggleRightMainPanelMode(
          RIGHT_MAIN_PANEL_MODES.CHANGES,
          ctx.currentWorkspaceId ?? undefined
        );
    },
  },

  ToggleLogsMode: {
    id: 'toggle-logs-mode',
    label: 'Toggle Logs Panel',
    icon: TerminalIcon,
    shortcut: 'V L',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => !ctx.isCreateMode && ctx.layoutMode === 'workspaces',
    isActive: (ctx) => ctx.rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.LOGS,
    isEnabled: (ctx) => !ctx.isCreateMode,
    getLabel: (ctx) =>
      ctx.rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.LOGS
        ? 'Hide Logs Panel'
        : 'Show Logs Panel',
    execute: (ctx) => {
      if (window.matchMedia('(max-width: 767px)').matches) {
        const store = useUiPreferencesStore.getState();
        store.setMobileActiveTab(
          store.mobileActiveTab === 'logs' ? 'chat' : 'logs'
        );
        return;
      }
      useUiPreferencesStore
        .getState()
        .toggleRightMainPanelMode(
          RIGHT_MAIN_PANEL_MODES.LOGS,
          ctx.currentWorkspaceId ?? undefined
        );
    },
  },

  TogglePreviewMode: {
    id: 'toggle-preview-mode',
    label: 'Toggle Preview Panel',
    icon: DesktopIcon,
    shortcut: 'V P',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => !ctx.isCreateMode && ctx.layoutMode === 'workspaces',
    isActive: (ctx) =>
      ctx.rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.PREVIEW,
    isEnabled: (ctx) => !ctx.isCreateMode,
    getLabel: (ctx) =>
      ctx.rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.PREVIEW
        ? 'Hide Preview Panel'
        : 'Show Preview Panel',
    execute: (ctx) => {
      if (window.matchMedia('(max-width: 767px)').matches) {
        const store = useUiPreferencesStore.getState();
        store.setMobileActiveTab(
          store.mobileActiveTab === 'preview' ? 'chat' : 'preview'
        );
        return;
      }
      useUiPreferencesStore
        .getState()
        .toggleRightMainPanelMode(
          RIGHT_MAIN_PANEL_MODES.PREVIEW,
          ctx.currentWorkspaceId ?? undefined
        );
    },
  },

  // === ContextBar Actions ===
  OpenInIDE: {
    id: 'open-in-ide',
    label: 'Open in IDE',
    icon: 'ide-icon' as const,
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.hasWorkspace,
    getTooltip: (ctx) => `Open in ${getIdeName(ctx.editorType)}`,
    execute: async (ctx) => {
      if (!ctx.currentWorkspaceId) return;
      try {
        const response =
          ctx.appRuntime === 'local' && ctx.currentHostId
            ? await relayApi.openRemoteWorkspaceInEditor({
                host_id: ctx.currentHostId,
                workspace_id: ctx.currentWorkspaceId,
                editor_type: null,
                file_path: null,
              })
            : await workspacesApi.openEditor(ctx.currentWorkspaceId, {
                editor_type: null,
                file_path: null,
                is_remote_web: ctx.appRuntime === 'remote',
              });
        if (response.url) {
          window.open(response.url, '_blank');
        }
      } catch {
        // Show editor selection dialog on failure
        EditorSelectionDialog.show({
          selectedAttemptId: ctx.currentWorkspaceId,
        });
      }
    },
  },

  CopyWorkspacePath: {
    id: 'copy-workspace-path',
    label: 'Copy Workspace Path',
    icon: 'copy-icon' as const,
    shortcut: 'Y P',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.hasWorkspace,
    execute: async (ctx) => {
      if (!ctx.containerRef) return;
      await navigator.clipboard.writeText(ctx.containerRef);
    },
  },

  CopyRawLogs: {
    id: 'copy-raw-logs',
    label: 'Copy Raw Logs',
    icon: CopyIcon,
    shortcut: 'Y L',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) =>
      ctx.rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.LOGS &&
      ctx.logsPanelContent?.type !== 'terminal',
    execute: async (ctx) => {
      if (!ctx.currentLogs || ctx.currentLogs.length === 0) return;
      const rawText = ctx.currentLogs.map((log) => log.content).join('\n');
      await navigator.clipboard.writeText(rawText);
    },
  },

  ToggleDevServer: {
    id: 'toggle-dev-server',
    label: 'Dev Server',
    icon: PlayIcon,
    shortcut: 'T D',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.hasWorkspace,
    isEnabled: (ctx) =>
      ctx.devServerState !== 'starting' && ctx.devServerState !== 'stopping',
    getIcon: (ctx) => {
      if (
        ctx.devServerState === 'starting' ||
        ctx.devServerState === 'stopping'
      ) {
        return SpinnerIcon;
      }
      if (ctx.devServerState === 'running') {
        return PauseIcon;
      }
      return PlayIcon;
    },
    getTooltip: (ctx) => {
      switch (ctx.devServerState) {
        case 'starting':
          return 'Starting dev server...';
        case 'stopping':
          return 'Stopping dev server...';
        case 'running':
          return 'Stop dev server';
        default:
          return 'Start dev server';
      }
    },
    getLabel: (ctx) =>
      ctx.devServerState === 'running' ? 'Stop Dev Server' : 'Start Dev Server',
    execute: (ctx) => {
      if (ctx.runningDevServers.length > 0) {
        ctx.stopDevServer();
      } else {
        ctx.startDevServer();
        // Auto-open preview mode when starting dev server
        useUiPreferencesStore
          .getState()
          .setRightMainPanelMode(
            RIGHT_MAIN_PANEL_MODES.PREVIEW,
            ctx.currentWorkspaceId ?? undefined
          );
      }
    },
  },

  // === Git Actions ===
  GitCommit: {
    id: 'git-commit',
    label: 'Commit',
    icon: GitCommitIcon,
    shortcut: 'X C',
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) =>
      ctx.hasWorkspace && ctx.hasGitRepos && ctx.hasUncommittedChanges,
    execute: async (ctx, workspaceId, repoId) => {
      const result = await workspacesApi.commit(workspaceId, {
        repo_id: repoId,
      });
      // `committed === false` means the worktree was clean — not an error.
      if (result.committed) {
        invalidateWorkspaceQueries(ctx.queryClient, workspaceId);
        ctx.queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        });
      }
    },
  },

  GitCreatePR: {
    id: 'git-create-pr',
    label: 'Create Pull Request',
    icon: GitPullRequestIcon,
    shortcut: 'X P',
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (ctx, workspaceId, repoId) => {
      const workspace = await getWorkspace(ctx.queryClient, workspaceId);

      const repos = await workspacesApi.getRepos(workspaceId);
      const repo = repos.find((r) => r.id === repoId);

      // Prefer opening the PR from the feature branch the work branch was merged
      // into (three-branch workflow); the dialog falls back to the work branch.
      const featureBranch = await findMergedFeatureBranch(workspaceId, repoId);

      // Resolve vibe-kanban identifier from remote workspace + issue
      let issueIdentifier: string | undefined;
      const remoteWs = findRemoteWorkspaceByLocalIdentity(
        ctx.remoteWorkspaces,
        workspaceId,
        ctx.currentHostId
      );
      if (remoteWs?.issue_id && ctx.projectMutations?.getIssue) {
        const issue = ctx.projectMutations.getIssue(remoteWs.issue_id);
        issueIdentifier = issue?.simple_id || remoteWs.issue_id;
      }

      const result = await CreatePRDialog.show({
        attempt: workspace,
        repoId,
        targetBranch: repo?.target_branch,
        headBranch: featureBranch,
        defaultBaseBranch: repo?.default_target_branch ?? undefined,
        issueIdentifier,
      });

      if (!result.success && result.error) {
        throw new Error(result.error);
      }
    },
  },

  // Fire-and-forget variant of Create PR: generate the title/description with
  // the agent and open a draft PR against the workspace's configured target
  // branch, all in the background. Progress shows on the git panel's repo card;
  // completion/errors surface as popups. No dialog is opened.
  GitCreatePRFromAI: {
    id: 'git-create-pr-from-ai',
    label: 'Create Pull Request from AI',
    icon: SparkleIcon,
    keywords: ['pull request', 'ai', 'draft', 'generate', 'pr'],
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (ctx, workspaceId, repoId) => {
      const [workspace, repos, featureBranch] = await Promise.all([
        getWorkspace(ctx.queryClient, workspaceId),
        workspacesApi.getRepos(workspaceId),
        findMergedFeatureBranch(workspaceId, repoId),
      ]);
      const repo = repos.find((r) => r.id === repoId);

      // Head (source): the feature branch the work branch was merged into
      // (three-branch flow) when present; otherwise null so the backend defaults
      // to the work branch.
      const headBranch = featureBranch ?? null;

      // This flow opens a PR without a dialog, so warn here before it pushes a
      // work branch that has never been pushed to origin.
      const proceed = await confirmUnpushedWorkBranchPush(
        workspaceId,
        repoId,
        workspace.branch,
        headBranch
      );
      if (!proceed) return;

      // Base (target): the workspace's configured target branch. For a feature
      // head the target IS the head, so fall back to the repo's default base.
      const targetBranch = featureBranch
        ? (repo?.default_target_branch ?? repo?.target_branch ?? null)
        : (repo?.target_branch ?? null);

      usePrFromAiBackgroundStore
        .getState()
        .startCreateFromAi(workspaceId, repoId, {
          targetBranch,
          headBranch,
          workBranch: workspace.branch,
        });
    },
  },

  GitOpenPR: {
    id: 'git-open-pr',
    label: 'Open PR in Web',
    icon: GitPullRequestIcon,
    keywords: ['pull request', 'browser'],
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos && ctx.hasOpenPR,
    execute: async (_ctx, workspaceId, repoId) => {
      const reservedWindow = reserveExternalWindow();
      try {
        const branchStatus = await workspacesApi.getBranchStatus(workspaceId);
        const repoStatus = branchStatus.find(
          (status) => status.repo_id === repoId
        );
        const openPr = repoStatus?.merges?.find(
          (merge: Merge) =>
            merge.type === 'pr' && merge.pr_info.status === 'open'
        );

        if (openPr?.type !== 'pr') {
          reservedWindow?.close();
          await ConfirmDialog.show({
            title: 'No Open Pull Request',
            message:
              'The selected repository does not have a connected open pull request.',
            confirmText: 'OK',
            showCancelButton: false,
            variant: 'info',
          });
          return;
        }

        if (!openExternalUrl(openPr.pr_info.url, reservedWindow)) {
          reservedWindow?.close();
        }
      } catch (error) {
        reservedWindow?.close();
        throw error;
      }
    },
  },

  GitViewPRDetails: {
    id: 'git-view-pr-details',
    label: 'View Pull Request Details',
    icon: GitPullRequestIcon,
    keywords: ['pull request', 'details', 'comments', 'reviews', 'pr'],
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos && ctx.hasLinkedPR,
    execute: async (_ctx, workspaceId, repoId) => {
      const branchStatus = await workspacesApi.getBranchStatus(workspaceId);
      const merges = branchStatus.find(
        (status) => status.repo_id === repoId
      )?.merges;
      // Match the PR panel: prefer an open PR, then keep the most recently
      // linked merged/closed PR available for read-only details.
      const pullRequest =
        merges?.find(
          (merge: Merge) =>
            merge.type === 'pr' && merge.pr_info.status === 'open'
        ) ?? merges?.find((merge: Merge) => merge.type === 'pr');
      if (pullRequest?.type !== 'pr' || !pullRequest.pr_info.url) return;
      await PrDetailsDialog.show({
        prUrl: pullRequest.pr_info.url,
        prNumber: Number(pullRequest.pr_info.number),
      });
    },
  },

  IssueOpenPRInWeb: {
    id: 'issue-open-pr-in-web',
    label: 'Open PR in Web',
    icon: GitPullRequestIcon,
    keywords: ['pull request', 'browser', 'web', 'pr'],
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, _projectId, issueIds) => {
      const pullRequest = await selectIssuePullRequest(ctx, issueIds);
      if (!pullRequest) return;

      const reservedWindow = reserveExternalWindow();
      if (!openExternalUrl(pullRequest.url, reservedWindow)) {
        reservedWindow?.close();
      }
    },
  } satisfies IssueActionDefinition,

  IssueViewPRDetails: {
    id: 'issue-view-pr-details',
    label: 'View Pull Request Details',
    icon: GitPullRequestIcon,
    keywords: ['pull request', 'details', 'comments', 'reviews', 'pr'],
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, _projectId, issueIds) => {
      const pullRequest = await selectIssuePullRequest(ctx, issueIds);
      if (!pullRequest) return;

      await PrDetailsDialog.show({
        prUrl: pullRequest.url,
        prNumber: pullRequest.number,
      });
    },
  } satisfies IssueActionDefinition,

  GitLinkPR: {
    id: 'git-link-pr',
    label: 'Link Pull Request',
    icon: LinkIcon,
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (ctx, workspaceId, repoId) => {
      // Search candidate head (source) branches for a linkable PR, in priority
      // order:
      //   1. the feature branch the work branch was merged into (three-branch
      //      flow — the PR's head is the intermediate feature branch)
      //   2. the work branch itself
      //   3. the repo's target branch — a PR may originate from the target
      //      branch itself (e.g. an upstream `target -> base` PR)
      const [featureBranch, targetBranch, workspace] = await Promise.all([
        findMergedFeatureBranch(workspaceId, repoId),
        findRepoTargetBranch(workspaceId, repoId),
        getWorkspace(ctx.queryClient, workspaceId),
      ]);

      // Sending the work branch explicitly is equivalent to null (the backend
      // default), which lets us dedupe candidates by branch name.
      const candidates = [featureBranch, workspace.branch, targetBranch].filter(
        (branch, i, arr): branch is string =>
          !!branch && arr.indexOf(branch) === i
      );

      const candidateResults = await Promise.all(
        candidates.map(async (headBranch) => ({
          headBranch,
          result: await workspacesApi.listAttachablePrs(
            workspaceId,
            repoId,
            headBranch
          ),
        }))
      );
      const failed = candidateResults.find(({ result }) => !result.success);
      if (failed && !failed.result.success) {
        throw new Error(
          failed.result.message || 'Failed to list pull requests'
        );
      }
      const availablePrs = Array.from(
        new Map(
          candidateResults
            .flatMap(({ result }) =>
              result.success ? result.data : ([] as PullRequestDetail[])
            )
            .map((pr) => [pr.url, pr])
        ).values()
      );
      if (availablePrs.length === 0) {
        await ConfirmDialog.show({
          title: 'No Pull Request Found',
          message:
            'No unlinked pull request was found matching this workspace branch.',
          confirmText: 'OK',
          showCancelButton: false,
          variant: 'info',
        });
        return;
      }

      const selectedPr = await (async () => {
        if (availablePrs.length === 1) return availablePrs[0];
        const { selectPullRequestToLink } = await import(
          '@/shared/dialogs/command-bar/selectPullRequestToLink'
        );
        return selectPullRequestToLink(availablePrs);
      })();
      if (!selectedPr) return;

      const result = await workspacesApi.attachPr(workspaceId, {
        repo_id: repoId,
        head_branch: selectedPr.head_branch,
        pr_url: selectedPr.url,
      });

      if (result.success && result.data.pr_attached && result.data.pr_number) {
        invalidateWorkspaceQueries(ctx.queryClient, workspaceId);
        ctx.queryClient.invalidateQueries({
          queryKey: ['branch-status'],
        });

        await ConfirmDialog.show({
          title: 'Pull Request Linked',
          message: `Linked PR #${result.data.pr_number}${result.data.pr_url ? ` — ${result.data.pr_url}` : ''}`,
          confirmText: 'OK',
          showCancelButton: false,
          variant: 'success',
        });
      } else if (result.success && !result.data.pr_attached) {
        await ConfirmDialog.show({
          title: 'No Pull Request Found',
          message:
            'No open pull request was found matching this branch. Make sure a PR exists for this branch on the remote.',
          confirmText: 'OK',
          showCancelButton: false,
          variant: 'info',
        });
      } else if (!result.success) {
        throw new Error(result.message || 'Failed to attach PR');
      }
    },
  },

  GitUnlinkPR: {
    id: 'git-unlink-pr',
    label: 'Unlink Pull Request',
    icon: LinkBreakIcon,
    keywords: ['pull request', 'unlink', 'detach', 'remove', 'pr'],
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos && ctx.hasLinkedPR,
    execute: async (ctx, workspaceId, repoId) => {
      // A repo can track more than one PR, so gather them all and let the user
      // pick which one to unlink (skipping the picker when there's only one).
      const branchStatus = await workspacesApi.getBranchStatus(workspaceId);
      const prMerges =
        branchStatus
          .find((status) => status.repo_id === repoId)
          ?.merges?.filter((merge: Merge) => merge.type === 'pr') ?? [];

      if (prMerges.length === 0) {
        await ConfirmDialog.show({
          title: 'No Linked Pull Request',
          message: 'There is no pull request linked to this repository.',
          confirmText: 'OK',
          showCancelButton: false,
          variant: 'info',
        });
        return;
      }

      // Open PRs first, then merged/closed, matching the PR panel ordering.
      const ordered = [
        ...prMerges.filter(
          (m: Merge) => m.type === 'pr' && m.pr_info.status === 'open'
        ),
        ...prMerges.filter(
          (m: Merge) => m.type === 'pr' && m.pr_info.status !== 'open'
        ),
      ];

      // Only PR merges with a URL can be unlinked by identity.
      const unlinkable = ordered.flatMap((m) =>
        m.type === 'pr' && m.pr_info.url
          ? [
              {
                url: m.pr_info.url,
                number: Number(m.pr_info.number),
                status: m.pr_info.status,
                headBranch: m.head_branch_name ?? '(work)',
                baseBranch: m.target_branch_name,
              },
            ]
          : []
      );

      let prUrl: string | undefined;
      if (unlinkable.length === 1) {
        prUrl = unlinkable[0].url;
      } else {
        const { selectPullRequestToUnlink } = await import(
          '@/shared/dialogs/command-bar/selectPullRequestToUnlink'
        );
        prUrl = await selectPullRequestToUnlink(unlinkable);
        if (!prUrl) return; // dismissed
      }

      if (!prUrl) return;
      const prNumber = unlinkable.find((p) => p.url === prUrl)?.number;

      const confirm = await ConfirmDialog.show({
        title: prNumber ? `Unlink PR #${prNumber}?` : 'Unlink pull request?',
        message:
          'This removes the link between the pull request and this workspace. The pull request itself is not affected.',
        confirmText: 'Unlink',
        variant: 'destructive',
      });
      if (confirm !== 'confirmed') return;

      await workspacesApi.unlinkPr(workspaceId, {
        repo_id: repoId,
        pr_url: prUrl,
      });

      invalidateWorkspaceQueries(ctx.queryClient, workspaceId);
      ctx.queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });
    },
  },

  GitMerge: {
    id: 'git-merge',
    label: 'Merge',
    icon: GitMergeIcon,
    shortcut: 'X M',
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (ctx, workspaceId, repoId) => {
      // Check for existing conflicts first
      const [workspace, branchStatus] = await Promise.all([
        getWorkspace(ctx.queryClient, workspaceId),
        workspacesApi.getBranchStatus(workspaceId),
      ]);
      const repoStatus = branchStatus?.find((s) => s.repo_id === repoId);

      // Only block direct merge when the open PR is from this workspace branch.
      // Feature-branch PRs must not block continued work -> feature merges.
      const hasOpenPR = repoStatus?.merges?.some((m: Merge) =>
        isOpenPrFromWorkspaceBranch(m, workspace.branch)
      );
      if (hasOpenPR) {
        await ConfirmDialog.show({
          title: 'Cannot Merge',
          message:
            'This repository has an open pull request. Please close or merge the PR before merging directly.',
          confirmText: 'OK',
          showCancelButton: false,
        });
        return;
      }

      const hasConflicts =
        repoStatus?.is_rebase_in_progress ||
        (repoStatus?.conflicted_files?.length ?? 0) > 0;

      if (hasConflicts && repoStatus) {
        // Skip showing the dialog if a process is already running
        // (e.g. an AI session is already resolving these conflicts)
        const isRunning = ctx.activeWorkspaces.find(
          (w) => w.id === workspaceId
        )?.isRunning;
        if (isRunning) return;

        // Show resolve conflicts dialog
        const result = await ResolveConflictsDialog.show({
          workspaceId,
          repoId,
          conflictOp: repoStatus.conflict_op ?? 'merge',
          sourceBranch: workspace.branch,
          targetBranch: repoStatus.target_branch_name,
          conflictedFiles: repoStatus.conflicted_files ?? [],
          repoName: repoStatus.repo_name,
        });

        if (result.action === 'resolved') {
          invalidateWorkspaceQueries(ctx.queryClient, workspaceId);
        }
        return;
      }

      // Check if branch is behind - need to rebase first
      const commitsBehind = repoStatus?.commits_behind ?? 0;
      if (commitsBehind > 0) {
        // Prompt user to rebase first
        const confirmRebase = await ConfirmDialog.show({
          title: 'Rebase Required',
          message: `Your branch is ${commitsBehind} commit${commitsBehind === 1 ? '' : 's'} behind the target branch. Would you like to rebase first?`,
          confirmText: 'Rebase',
          cancelText: 'Cancel',
        });

        if (confirmRebase === 'confirmed') {
          // Open rebase dialog - it loads branches/status internally
          await RebaseDialog.show({
            workspaceId: workspaceId,
            repoId,
          });
        }
        return;
      }

      const confirmResult = await ConfirmDialog.show({
        title: 'Merge Branch',
        message:
          'Are you sure you want to merge this branch into the target branch?',
        confirmText: 'Merge',
        cancelText: 'Cancel',
      });

      if (confirmResult === 'confirmed') {
        await workspacesApi.merge(workspaceId, { repo_id: repoId });
        invalidateWorkspaceQueries(ctx.queryClient, workspaceId);
      }
    },
  },

  GitRebase: {
    id: 'git-rebase',
    label: 'Rebase',
    icon: ArrowsClockwiseIcon,
    shortcut: 'X R',
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (_ctx, workspaceId, repoId) => {
      // Open rebase dialog - it loads branches/status internally and handles conflicts
      await RebaseDialog.show({
        workspaceId: workspaceId,
        repoId,
      });
    },
  },

  // Fast-forward the work branch to its own remote (git pull --ff-only). Never
  // touches the remote, so it is safe on shared PR branches; reports when a
  // fast-forward is impossible (diverged) instead of changing anything.
  GitPull: {
    id: 'git-pull',
    label: 'Pull work branch',
    icon: ArrowDownIcon,
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (ctx, workspaceId, repoId) => {
      const outcome = await workspacesApi.pull(workspaceId, {
        repo_id: repoId,
      });
      ctx.queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });

      if (outcome.type === 'fast_forwarded') {
        invalidateWorkspaceQueries(ctx.queryClient, workspaceId);
        await ConfirmDialog.show({
          title: 'Pull complete',
          message: `Fast-forwarded ${outcome.commits} commit${
            outcome.commits === 1 ? '' : 's'
          } from the remote.`,
          confirmText: 'OK',
          showCancelButton: false,
          variant: 'success',
        });
      } else if (outcome.type === 'diverged') {
        await ReconcileRemoteBranchDialog.show({
          workspaceId,
          repoId,
          ahead: outcome.ahead,
          behind: outcome.behind,
        });
      } else {
        await ConfirmDialog.show({
          title: 'Already up to date',
          message: 'Your branch already matches its remote.',
          confirmText: 'OK',
          showCancelButton: false,
          variant: 'info',
        });
      }
    },
  },

  // Bring the target (base) branch into the work branch via merge. Unlike
  // GitRebase this preserves history, so it is the safe default for shared PR
  // branches. Conflicts are surfaced through the existing resolve-conflicts flow.
  GitUpdateFromBase: {
    id: 'git-update-from-base',
    label: 'Update work branch from target branch',
    icon: GitMergeIcon,
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (ctx, workspaceId, repoId) => {
      const branchStatus = await workspacesApi.getBranchStatus(workspaceId);
      const repoStatus = branchStatus?.find((s) => s.repo_id === repoId);

      // Already mid-conflict: open the resolver instead of starting a new merge.
      const hasConflicts =
        repoStatus?.is_rebase_in_progress ||
        (repoStatus?.conflicted_files?.length ?? 0) > 0;
      if (hasConflicts && repoStatus) {
        const isRunning = ctx.activeWorkspaces.find(
          (w) => w.id === workspaceId
        )?.isRunning;
        if (isRunning) return;

        const workspace = await getWorkspace(ctx.queryClient, workspaceId);
        await ResolveConflictsDialog.show({
          workspaceId,
          repoId,
          conflictOp: repoStatus.conflict_op ?? 'merge',
          sourceBranch: repoStatus.target_branch_name,
          targetBranch: workspace.branch,
          conflictedFiles: repoStatus.conflicted_files ?? [],
          repoName: repoStatus.repo_name,
        });
        invalidateWorkspaceQueries(ctx.queryClient, workspaceId);
        return;
      }

      const commitsBehind = repoStatus?.commits_behind ?? 0;
      if (commitsBehind === 0) {
        await ConfirmDialog.show({
          title: 'Already up to date',
          message:
            'This branch already contains every commit from its base branch.',
          confirmText: 'OK',
          showCancelButton: false,
          variant: 'info',
        });
        return;
      }

      const confirmResult = await ConfirmDialog.show({
        title: 'Update work branch from target branch',
        message: `Merge "${
          repoStatus?.target_branch_name ?? 'the base branch'
        }" into this branch? Your branch is ${commitsBehind} commit${
          commitsBehind === 1 ? '' : 's'
        } behind.`,
        confirmText: 'Update',
        cancelText: 'Cancel',
      });
      if (confirmResult !== 'confirmed') return;

      const result = await workspacesApi.updateFromBase(workspaceId, {
        repo_id: repoId,
        strategy: 'merge',
      });
      ctx.queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });

      if (!result.success) {
        const err = result.error;
        if (err?.type === 'merge_conflicts') {
          const workspace = await getWorkspace(ctx.queryClient, workspaceId);
          await ResolveConflictsDialog.show({
            workspaceId,
            repoId,
            conflictOp: 'merge',
            sourceBranch: err.target_branch,
            targetBranch: workspace.branch,
            conflictedFiles: err.conflicted_files ?? [],
            repoName: repoStatus?.repo_name,
          });
          invalidateWorkspaceQueries(ctx.queryClient, workspaceId);
          return;
        }
        throw new Error(
          result.message || 'Failed to update work branch from target branch'
        );
      }

      invalidateWorkspaceQueries(ctx.queryClient, workspaceId);
    },
  },

  GitUpdateTargetFromBase: {
    id: 'git-update-target-from-base',
    label: 'Update target branch from base branch',
    icon: GitMergeIcon,
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (ctx, workspaceId, repoId) => {
      const baseBranch = await BranchPickerDialog.show({
        repoId,
        mode: 'updateTargetFromBase',
      });
      if (!baseBranch) return;

      const confirmResult = await ConfirmDialog.show({
        title: 'Update target branch from base branch',
        message: `Merge "${baseBranch}" into this workspace's target branch?`,
        confirmText: 'Update',
        cancelText: 'Cancel',
      });
      if (confirmResult !== 'confirmed') return;

      await workspacesApi.updateTargetBranchFromBase(workspaceId, {
        repo_id: repoId,
        base_branch: baseBranch,
      });
      invalidateWorkspaceQueries(ctx.queryClient, workspaceId);
    },
  },

  GitChangeTarget: {
    id: 'git-change-target',
    label: 'Change Target Branch',
    icon: CrosshairIcon,
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (ctx, workspaceId, repoId) => {
      const newTargetBranch = await BranchPickerDialog.show({
        repoId,
        mode: 'changeTarget',
      });
      if (!newTargetBranch) return;

      await workspacesApi.change_target_branch(workspaceId, {
        new_target_branch: newTargetBranch,
        repo_id: repoId,
      });

      ctx.queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });
      ctx.queryClient.invalidateQueries({
        queryKey: workspaceRecordKeys.byId(workspaceId),
      });
      ctx.queryClient.invalidateQueries({
        queryKey: workspaceRepoKeys.byWorkspace(workspaceId),
      });
      ctx.queryClient.invalidateQueries({
        queryKey: repoBranchKeys.byRepo(repoId),
      });
    },
  },

  GitPush: {
    id: 'git-push',
    label: 'Push',
    icon: ArrowUpIcon,
    shortcut: 'X U',
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) =>
      ctx.hasWorkspace &&
      ctx.hasGitRepos &&
      ctx.hasOpenPR &&
      ctx.hasUnpushedCommits,
    execute: async (ctx, workspaceId, repoId) => {
      const result = await workspacesApi.push(workspaceId, { repo_id: repoId });
      if (!result.success) {
        if (result.error?.type === 'diverged') {
          await ReconcileRemoteBranchDialog.show({
            workspaceId,
            repoId,
            ahead: result.error.ahead,
            behind: result.error.behind,
            triggeredByPush: true,
          });
          return;
        }
        if (result.error?.type === 'force_push_required') {
          await ForcePushDialog.show({ workspaceId, repoId });
          return;
        }
        throw new Error('Failed to push changes');
      }
      invalidateWorkspaceQueries(ctx.queryClient, workspaceId);
    },
  },

  // Preserve the legacy action id for saved command-bar preferences. A normal
  // pull fast-forwards; divergence opens the same recovery choices as work pull.
  GitFetchTarget: {
    id: 'git-fetch-target',
    label: 'Pull target branch',
    icon: ArrowLineDownIcon,
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (ctx, workspaceId, repoId) => {
      const outcome = await workspacesApi.pullTargetBranch(workspaceId, repoId);
      ctx.queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });
      ctx.queryClient.invalidateQueries({
        queryKey: ['targetBranchRemoteStatus', workspaceId, repoId],
      });

      if (outcome.type === 'diverged') {
        await ReconcileRemoteBranchDialog.show({
          workspaceId,
          repoId,
          ahead: outcome.ahead,
          behind: outcome.behind,
          isTarget: true,
        });
        return;
      }

      const pulled = outcome.type === 'fast_forwarded';
      await ConfirmDialog.show({
        title: pulled ? 'Pull complete' : 'Already up to date',
        message: pulled
          ? `Fast-forwarded ${outcome.commits} commit${outcome.commits === 1 ? '' : 's'} from the remote.`
          : 'The target branch already matches its remote.',
        confirmText: 'OK',
        showCancelButton: false,
        variant: pulled ? 'success' : 'info',
      });
    },
  },

  // Push the workspace's target (base) branch to the repo's origin. Useful after
  // merging the work branch into the local target branch, to publish it.
  GitPushTarget: {
    id: 'git-push-target',
    label: 'Push target branch',
    icon: ArrowLineUpIcon,
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (ctx, workspaceId, repoId) => {
      const invalidate = () => {
        ctx.queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        });
        ctx.queryClient.invalidateQueries({
          queryKey: ['targetBranchRemoteStatus', workspaceId, repoId],
        });
      };

      const result = await workspacesApi.pushTargetBranch(
        workspaceId,
        repoId,
        false
      );
      invalidate();

      if (result.success) {
        await ConfirmDialog.show({
          title: 'Push complete',
          message: `Pushed "${result.data.target_branch}" to ${
            result.data.remote ?? 'the remote'
          }.`,
          confirmText: 'OK',
          showCancelButton: false,
          variant: 'success',
        });
        return;
      }

      if (result.error?.type === 'diverged') {
        const choice = await PullFirstDialog.show({
          workspaceId,
          repoId,
          ahead: result.error.ahead,
          behind: result.error.behind,
          isTarget: true,
        });
        if (choice !== 'force') return;
      }

      if (
        result.error?.type === 'force_push_required' ||
        result.error?.type === 'diverged'
      ) {
        const confirm = await ConfirmDialog.show({
          title: 'Force push required',
          message:
            'The remote target branch has diverged from your local one. Force push to overwrite it? This can discard commits that only exist on the remote.',
          confirmText: 'Force push',
          cancelText: 'Cancel',
          variant: 'destructive',
        });
        if (confirm !== 'confirmed') return;

        const forced = await workspacesApi.pushTargetBranch(
          workspaceId,
          repoId,
          true
        );
        invalidate();
        if (!forced.success) {
          throw new Error(
            forced.message || 'Failed to force-push the target branch'
          );
        }
        await ConfirmDialog.show({
          title: 'Push complete',
          message: `Force-pushed "${forced.data.target_branch}" to ${
            forced.data.remote ?? 'the remote'
          }.`,
          confirmText: 'OK',
          showCancelButton: false,
          variant: 'success',
        });
        return;
      }

      throw new Error(result.message || 'Failed to push the target branch');
    },
  },

  // === Repo-specific Actions (for command bar when selecting a repo) ===
  RepoCopyPath: {
    id: 'repo-copy-path',
    label: 'Copy Repo Path',
    icon: CopyIcon,
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (_ctx, _workspaceId, repoId) => {
      try {
        const repo = await repoApi.getById(repoId);
        if (repo?.path) {
          await navigator.clipboard.writeText(repo.path);
        }
      } catch (err) {
        console.error('Failed to copy repo path:', err);
        throw new Error('Failed to copy repository path');
      }
    },
  },

  RepoOpenInIDE: {
    id: 'repo-open-in-ide',
    label: 'Open Repo in IDE',
    icon: DesktopIcon,
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (ctx, _workspaceId, repoId) => {
      try {
        const response = await repoApi.openEditor(repoId, {
          editor_type: null,
          file_path: null,
          is_remote_web: ctx.appRuntime === 'remote',
        });
        if (response.url) {
          window.open(response.url, '_blank');
        }
      } catch (err) {
        console.error('Failed to open repo in editor:', err);
        throw new Error('Failed to open repository in IDE');
      }
    },
  },

  RepoSettings: {
    id: 'repo-settings',
    label: 'Repository Settings',
    icon: GearIcon,
    requiresTarget: ActionTargetType.GIT,
    isVisible: (ctx) => ctx.hasWorkspace && ctx.hasGitRepos,
    execute: async (_ctx, _workspaceId, repoId) => {
      await SettingsDialog.show({
        initialSection: 'repos',
        initialState: {
          repoId,
        },
      });
    },
  },

  // === Script Actions ===
  RunSetupScript: {
    id: 'run-setup-script',
    label: 'Run Setup Script',
    icon: TerminalIcon,
    shortcut: 'R S',
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) => ctx.hasWorkspace,
    isEnabled: (ctx) => !ctx.isAttemptRunning,
    execute: async (_ctx, workspaceId, hostId) => {
      const result = await workspacesApi.runSetupScript(workspaceId, hostId);
      if (!result.success) {
        if (result.error?.type === 'no_script_configured') {
          throw new Error('No setup script configured for this project');
        }
        if (result.error?.type === 'process_already_running') {
          throw new Error('Cannot run script while another process is running');
        }
        throw new Error('Failed to run setup script');
      }
    },
  },

  RunCleanupScript: {
    id: 'run-cleanup-script',
    label: 'Run Cleanup Script',
    icon: TerminalIcon,
    shortcut: 'R C',
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) => ctx.hasWorkspace,
    isEnabled: (ctx) => !ctx.isAttemptRunning,
    execute: async (_ctx, workspaceId, hostId) => {
      const result = await workspacesApi.runCleanupScript(workspaceId, hostId);
      if (!result.success) {
        if (result.error?.type === 'no_script_configured') {
          throw new Error('No cleanup script configured for this project');
        }
        if (result.error?.type === 'process_already_running') {
          throw new Error('Cannot run script while another process is running');
        }
        throw new Error('Failed to run cleanup script');
      }
    },
  },

  RunArchiveScript: {
    id: 'run-archive-script',
    label: 'Run Archive Script',
    icon: TerminalIcon,
    shortcut: 'R A',
    requiresTarget: ActionTargetType.WORKSPACE,
    isVisible: (ctx) => ctx.hasWorkspace,
    isEnabled: (ctx) => !ctx.isAttemptRunning,
    execute: async (_ctx, workspaceId, hostId) => {
      const result = await workspacesApi.runArchiveScript(workspaceId, hostId);
      if (!result.success) {
        if (result.error?.type === 'no_script_configured') {
          throw new Error('No archive script configured for this project');
        }
        if (result.error?.type === 'process_already_running') {
          throw new Error('Cannot run script while another process is running');
        }
        throw new Error('Failed to run archive script');
      }
    },
  } satisfies WorkspaceActionDefinition,

  // === Issue Actions ===
  CreateIssue: {
    id: 'create-issue',
    label: 'Create Issue',
    icon: PlusIcon,
    shortcut: 'I C',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'kanban' && !ctx.isCreatingIssue,
    execute: (ctx) => {
      ctx.navigateToCreateIssue({ statusId: ctx.defaultCreateStatusId });
    },
  } satisfies GlobalActionDefinition,

  ChangeIssueStatus: {
    id: 'change-issue-status',
    label: 'Change Status',
    icon: ArrowsLeftRightIcon,
    shortcut: 'I S',
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, projectId, issueIds) => {
      await ctx.openStatusSelection(projectId, issueIds);
    },
  } satisfies IssueActionDefinition,

  ChangeNewIssueStatus: {
    id: 'change-new-issue-status',
    label: 'Change Status',
    icon: ArrowsLeftRightIcon,
    shortcut: 'I S',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'kanban' && ctx.isCreatingIssue,
    execute: async (ctx) => {
      if (!ctx.kanbanProjectId) return;
      const { ProjectSelectionDialog } = await import(
        '@/shared/dialogs/command-bar/selections/ProjectSelectionDialog'
      );
      await ProjectSelectionDialog.show({
        projectId: ctx.kanbanProjectId,
        selection: { type: 'status', issueIds: [], isCreateMode: true },
      });
    },
  } satisfies GlobalActionDefinition,

  ChangePriority: {
    id: 'change-issue-priority',
    label: 'Change Priority',
    icon: ArrowFatLineUpIcon,
    shortcut: 'I P',
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, projectId, issueIds) => {
      await ctx.openPrioritySelection(projectId, issueIds);
    },
  } satisfies IssueActionDefinition,

  ChangeNewIssuePriority: {
    id: 'change-new-issue-priority',
    label: 'Change Priority',
    icon: ArrowFatLineUpIcon,
    shortcut: 'I P',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'kanban' && ctx.isCreatingIssue,
    execute: async (ctx) => {
      if (!ctx.kanbanProjectId) return;
      const { ProjectSelectionDialog } = await import(
        '@/shared/dialogs/command-bar/selections/ProjectSelectionDialog'
      );
      await ProjectSelectionDialog.show({
        projectId: ctx.kanbanProjectId,
        selection: { type: 'priority', issueIds: [], isCreateMode: true },
      });
    },
  } satisfies GlobalActionDefinition,

  ChangeAssignees: {
    id: 'change-assignees',
    label: 'Change Assignees',
    icon: UsersIcon,
    shortcut: 'I A',
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, projectId, issueIds) => {
      await ctx.openAssigneeSelection(projectId, issueIds, false);
    },
  } satisfies IssueActionDefinition,

  ChangeNewIssueAssignees: {
    id: 'change-new-issue-assignees',
    label: 'Change Assignees',
    icon: UsersIcon,
    shortcut: 'I A',
    requiresTarget: ActionTargetType.NONE,
    isVisible: (ctx) => ctx.layoutMode === 'kanban' && ctx.isCreatingIssue,
    execute: async (ctx) => {
      // Opens assignee selection for the issue being created
      // ProjectId will be resolved from route params inside the dialog
      await ctx.openAssigneeSelection('', [], true);
    },
  } satisfies GlobalActionDefinition,

  MakeSubIssueOf: {
    id: 'make-sub-issue-of',
    label: 'Make Sub-issue of',
    icon: TreeStructureIcon,
    shortcut: 'I M',
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, projectId, issueIds) => {
      if (issueIds.length === 1) {
        await ctx.openSubIssueSelection(projectId, issueIds[0], 'setParent');
      }
    },
  } satisfies IssueActionDefinition,

  AddSubIssue: {
    id: 'add-sub-issue',
    label: 'Add Sub-issue',
    icon: PlusIcon,
    shortcut: 'I B',
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, projectId, issueIds) => {
      if (issueIds.length !== 1) return;
      const parentIssueId = issueIds[0];
      const result = await ctx.openSubIssueSelection(
        projectId,
        parentIssueId,
        'addChild'
      );
      if (result?.type === 'createNew') {
        navigateToCreateSubIssue(ctx, parentIssueId);
      }
    },
  } satisfies IssueActionDefinition,

  CreateSubIssue: {
    id: 'create-sub-issue',
    label: 'Create Sub-issue',
    icon: PlusIcon,
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, _projectId, issueIds) => {
      if (issueIds.length !== 1) return;
      navigateToCreateSubIssue(ctx, issueIds[0]);
    },
  } satisfies IssueActionDefinition,

  RemoveParentIssue: {
    id: 'remove-parent-issue',
    label: 'Remove Parent',
    icon: XIcon,
    shortcut: 'I U',
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' &&
      ctx.hasSelectedKanbanIssue &&
      ctx.hasSelectedKanbanIssueParent,
    execute: async (_ctx, _projectId, issueIds) => {
      await bulkUpdateIssues(
        issueIds.map((issueId) => ({
          id: issueId,
          changes: {
            parent_issue_id: null,
            parent_issue_sort_order: null,
          },
        }))
      );
    },
  } satisfies IssueActionDefinition,

  LinkWorkspace: {
    id: 'link-workspace',
    label: 'Link Workspace',
    icon: LinkIcon,
    shortcut: 'I W',
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, projectId, issueIds) => {
      if (issueIds.length === 1) {
        await ctx.openWorkspaceSelection(projectId, issueIds[0]);
      }
    },
  } satisfies IssueActionDefinition,

  LinkPullRequest: {
    id: 'link-pull-request',
    label: 'Link Pull Request to Issue',
    icon: LinkIcon,
    keywords: ['pull request', 'link', 'pr', 'issue'],
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, _projectId, issueIds) => {
      if (issueIds.length !== 1) return;
      await ctx.projectMutations?.linkPullRequest(issueIds[0]);
    },
  } satisfies IssueActionDefinition,

  LinkGithubIssue: {
    id: 'link-github-issue',
    label: 'Link GitHub Issue',
    icon: LinkIcon,
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, _projectId, issueIds) => {
      if (issueIds.length !== 1) return;
      await ctx.projectMutations?.linkGithubIssue(issueIds[0]);
    },
  } satisfies IssueActionDefinition,

  DeleteIssue: {
    id: 'delete-issue',
    label: 'Delete Issue',
    icon: TrashIcon,
    shortcut: 'I X',
    variant: 'destructive',
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, _projectId, issueIds) => {
      const count = issueIds.length;
      const result = await ConfirmDialog.show({
        title: count === 1 ? 'Delete Issue' : `Delete ${count} Issues`,
        message:
          count === 1
            ? 'Are you sure you want to delete this issue? This action cannot be undone.'
            : `Are you sure you want to delete these ${count} issues? This action cannot be undone.`,
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'destructive',
      });
      if (result === 'confirmed' && ctx.projectMutations?.removeIssue) {
        for (const issueId of issueIds) {
          ctx.projectMutations.removeIssue(issueId);
        }
      }
    },
  } satisfies IssueActionDefinition,

  DuplicateIssue: {
    id: 'duplicate-issue',
    label: 'Duplicate Issue',
    icon: CopyIcon,
    shortcut: 'I D',
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, _projectId, issueIds) => {
      if (issueIds.length !== 1) {
        throw new Error('Can only duplicate one issue at a time');
      }
      ctx.projectMutations?.duplicateIssue(issueIds[0]);
    },
  } satisfies IssueActionDefinition,

  MarkBlocking: {
    id: 'mark-blocking',
    label: 'Mark Blocking',
    icon: ArrowBendUpRightIcon,
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, projectId, issueIds) => {
      if (issueIds.length === 1) {
        await ctx.openRelationshipSelection(
          projectId,
          issueIds[0],
          'blocking',
          'forward'
        );
      }
    },
  } satisfies IssueActionDefinition,

  MarkBlockedBy: {
    id: 'mark-blocked-by',
    label: 'Mark Blocked By',
    icon: ProhibitIcon,
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, projectId, issueIds) => {
      if (issueIds.length === 1) {
        await ctx.openRelationshipSelection(
          projectId,
          issueIds[0],
          'blocking',
          'reverse'
        );
      }
    },
  } satisfies IssueActionDefinition,

  MarkRelated: {
    id: 'mark-related',
    label: 'Mark Related',
    icon: ArrowsLeftRightIcon,
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, projectId, issueIds) => {
      if (issueIds.length === 1) {
        await ctx.openRelationshipSelection(
          projectId,
          issueIds[0],
          'related',
          'forward'
        );
      }
    },
  } satisfies IssueActionDefinition,

  MarkDuplicateOf: {
    id: 'mark-duplicate-of',
    label: 'Mark Duplicate Of',
    icon: CopyIcon,
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, projectId, issueIds) => {
      if (issueIds.length === 1) {
        await ctx.openRelationshipSelection(
          projectId,
          issueIds[0],
          'has_duplicate',
          'forward'
        );
      }
    },
  } satisfies IssueActionDefinition,
} as const satisfies Record<string, ActionDefinition>;

// Navbar action groups define which actions appear in each section
export const NavbarActionGroups = {
  left: [Actions.ArchiveWorkspace] as NavbarItem[],
  right: [
    Actions.ToggleAppBar,
    Actions.ToggleDiffViewMode,
    NavbarDivider,
    Actions.ToggleLeftSidebar,
    Actions.ToggleLeftMainPanel,
    Actions.ToggleChangesMode,
    Actions.ToggleLogsMode,
    Actions.TogglePreviewMode,
    Actions.ToggleRightSidebar,
    NavbarDivider,
    Actions.OpenCommandBar,
    Actions.WorkspacesGuide,
    Actions.ProjectsGuide,
    Actions.Settings,
  ] as NavbarItem[],
};

// ContextBar action groups define which actions appear in each section
export const ContextBarActionGroups = {
  primary: [Actions.OpenInIDE, Actions.CopyWorkspacePath] as ActionDefinition[],
  secondary: [
    Actions.ToggleDevServer,
    Actions.TogglePreviewMode,
    Actions.ToggleChangesMode,
  ] as ActionDefinition[],
};
