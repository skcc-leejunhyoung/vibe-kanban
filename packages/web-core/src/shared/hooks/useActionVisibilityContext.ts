import { useMemo } from 'react';
import {
  useWorkspacePanelState,
  type LayoutMode,
} from '@/shared/stores/useUiPreferencesStore';
import { useDiffViewMode } from '@/shared/stores/useDiffViewStore';
import { useDiffPaths } from '@/shared/stores/useWorkspaceDiffStore';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useDevServer } from '@/shared/hooks/useDevServer';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { useShape } from '@/shared/integrations/electric/hooks';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { useLogsPanel } from '@/shared/hooks/useLogsPanel';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { isProjectDestination } from '@/shared/lib/routes/appNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import { PROJECT_ISSUES_SHAPE } from 'shared/remote-types';
import type { Merge } from 'shared/types';
import type {
  ActionVisibilityContext,
  DevServerState,
} from '@/shared/types/actions';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useChromeTargetWorkspace } from '@/shared/lib/openInSplitPane';

interface ActionVisibilityOptions {
  projectId?: string;
  issueIds?: string[];
}

/**
 * Hook that builds the visibility context from stores/context.
 * Used by both NavbarContainer and CommandBarDialog to evaluate
 * action visibility and state conditions.
 */
export function useActionVisibilityContext(
  options?: ActionVisibilityOptions
): ActionVisibilityContext {
  const appRuntime = useAppRuntime();
  const currentHostId = useHostId();
  const { workspace, workspaceId, isCreateMode, repos } = useWorkspaceContext();
  // Per-workspace panel state. Document chrome (navbar, command bar) reflects
  // the active split pane's workspace when one is focused, so its toggle
  // indicators match the pane those toggles act on; pane subtrees stay scoped
  // to themselves via the destination override.
  const chromeTargetWorkspace = useChromeTargetWorkspace();
  const panelState = useWorkspacePanelState(
    chromeTargetWorkspace?.workspaceId ??
      (isCreateMode ? undefined : workspaceId)
  );
  const diffPathsSet = useDiffPaths();
  const diffViewMode = useDiffViewMode();

  // Derive kanban state from the current destination (single source of
  // truth; split panes override it for their subtree).
  const destination = useCurrentAppDestination();
  const routeProjectId =
    destination && 'projectId' in destination
      ? destination.projectId
      : undefined;
  const routeIssueId =
    destination && 'issueId' in destination ? destination.issueId : undefined;
  const { isCreateMode: kanbanCreateMode } = useCurrentKanbanRouteState();
  const effectiveProjectId = options?.projectId ?? routeProjectId;
  const optionIssueIds = options?.issueIds;
  const effectiveIssueIds = useMemo(
    () => optionIssueIds ?? (routeIssueId ? [routeIssueId] : []),
    [optionIssueIds, routeIssueId]
  );
  const hasSelectedKanbanIssue = effectiveIssueIds.length > 0;
  const shouldResolveSelectedIssueParent =
    !!effectiveProjectId && effectiveIssueIds.length === 1;

  const projectIssuesParams = useMemo(
    () => ({ project_id: effectiveProjectId ?? '' }),
    [effectiveProjectId]
  );
  const { data: projectIssues } = useShape(
    PROJECT_ISSUES_SHAPE,
    projectIssuesParams,
    {
      enabled: shouldResolveSelectedIssueParent,
    }
  );
  const hasSelectedKanbanIssueParent = useMemo(() => {
    if (!shouldResolveSelectedIssueParent) return false;
    const selectedIssue = projectIssues.find(
      (issue) => issue.id === effectiveIssueIds[0]
    );
    return !!selectedIssue?.parent_issue_id;
  }, [shouldResolveSelectedIssueParent, projectIssues, effectiveIssueIds]);

  // Derive layoutMode from current destination instead of persisted state
  const layoutMode: LayoutMode =
    destination?.kind === 'pull-requests'
      ? 'pull-requests'
      : isProjectDestination(destination)
        ? 'kanban'
        : 'workspaces';
  const { config } = useUserSystem();
  const { isStarting, isStopping, runningDevServers } =
    useDevServer(workspaceId);
  const { data: branchStatus } = useBranchStatus(workspaceId);
  const { isAttemptRunningVisible } = useExecutionProcessesContext();
  const { logsPanelContent } = useLogsPanel();
  const { isSignedIn } = useAuth();
  const isMobile = useIsMobile();

  return useMemo(() => {
    // Compute dev server state
    const devServerState: DevServerState = isStarting
      ? 'starting'
      : isStopping
        ? 'stopping'
        : runningDevServers.length > 0
          ? 'running'
          : 'stopped';

    // Compute git state from branch status
    const hasLinkedPR =
      branchStatus?.some((repo) =>
        repo.merges?.some((m: Merge) => m.type === 'pr')
      ) ?? false;
    const hasOpenPR =
      branchStatus?.some((repo) =>
        repo.merges?.some(
          (m: Merge) => m.type === 'pr' && m.pr_info.status === 'open'
        )
      ) ?? false;

    const hasUnpushedCommits =
      branchStatus?.some((repo) => (repo.remote_commits_ahead ?? 0) > 0) ??
      false;

    const hasUncommittedChanges =
      branchStatus?.some((repo) => repo.has_uncommitted_changes) ?? false;

    return {
      appRuntime,
      currentHostId,
      layoutMode,
      rightMainPanelMode: panelState.rightMainPanelMode,
      isLeftSidebarVisible: panelState.isLeftSidebarVisible,
      isLeftMainPanelVisible: panelState.isLeftMainPanelVisible,
      isRightSidebarVisible: panelState.isRightSidebarVisible,
      isCreateMode,
      hasWorkspace: !!workspace,
      isCurrentWorkspaceTarget: !!workspace,
      workspaceArchived: workspace?.archived ?? false,
      isInPlace: workspace?.in_place ?? false,
      hasDiffs: diffPathsSet.size > 0,
      diffViewMode,
      editorType: config?.editor?.editor_type ?? null,
      devServerState,
      runningDevServers,
      hasGitRepos: repos.length > 0,
      hasMultipleRepos: repos.length > 1,
      hasLinkedPR,
      hasOpenPR,
      hasUnpushedCommits,
      hasUncommittedChanges,
      isAttemptRunning: isAttemptRunningVisible,
      logsPanelContent,
      hasSelectedKanbanIssue,
      hasSelectedKanbanIssueParent,
      isCreatingIssue: kanbanCreateMode,
      isSignedIn,
      isMobile,
    };
  }, [
    appRuntime,
    currentHostId,
    layoutMode,
    panelState.rightMainPanelMode,
    panelState.isLeftSidebarVisible,
    panelState.isLeftMainPanelVisible,
    panelState.isRightSidebarVisible,
    isCreateMode,
    workspace,
    repos,
    diffPathsSet,
    diffViewMode,
    config?.editor?.editor_type,
    isStarting,
    isStopping,
    runningDevServers,
    branchStatus,
    isAttemptRunningVisible,
    logsPanelContent,
    hasSelectedKanbanIssue,
    hasSelectedKanbanIssueParent,
    kanbanCreateMode,
    isSignedIn,
    isMobile,
  ]);
}
