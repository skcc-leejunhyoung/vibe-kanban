import { ReactNode, useMemo, useCallback, useEffect, useRef } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { useWorkspaceRecord } from '@/shared/hooks/useWorkspaceRecord';
import { useWorkspaceRepo } from '@/shared/hooks/useWorkspaceRepo';
import { useWorkspaceSessions } from '@/shared/hooks/useWorkspaceSessions';
import { useGitHubComments } from '@/shared/hooks/useGitHubComments';
import { useDiffStream } from '@/shared/hooks/useDiffStream';
import { useCommitDiff } from '@/shared/hooks/useCommitDiff';
import { workspacesApi } from '@/shared/lib/api';
import { useWorkspaceDiffStore } from '@/shared/stores/useWorkspaceDiffStore';
import { useSelectedCommit } from '@/shared/stores/useChangesCommitStore';
import { useHostId } from '@/shared/providers/HostIdProvider';
import type { Diff, DiffStats, WorkspaceSummary } from 'shared/types';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';

import { WorkspaceContext } from '@/shared/hooks/useWorkspaceContext';

interface WorkspaceProviderProps {
  children: ReactNode;
}

// Stable reference so an empty commit-diff result doesn't churn downstream memos.
const EMPTY_DIFFS: Diff[] = [];

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const { workspaceId } = useParams({ strict: false });
  const appNavigation = useAppNavigation();
  const currentDestination = useCurrentAppDestination();
  const queryClient = useQueryClient();
  const hostId = useHostId();

  const isCreateMode = currentDestination?.kind === 'workspaces-create';

  const {
    workspaces: activeWorkspaces,
    archivedWorkspaces,
    workspaceRecordsById,
    isLoading: isLoadingList,
  } = useWorkspaces();

  const { data: workspace, isLoading: isLoadingWorkspace } = useWorkspaceRecord(
    workspaceId,
    {
      enabled: !!workspaceId && !isCreateMode,
      // The list stream usually already has this workspace's row; serving it
      // as placeholder paints the page instantly instead of a full-pane
      // spinner while the record query fetches.
      placeholderData: workspaceId
        ? workspaceRecordsById[workspaceId]
        : undefined,
    }
  );

  const {
    sessions,
    selectedSession,
    selectedSessionId,
    selectSession,
    selectLatestSession,
    isLoading: isSessionsLoading,
    isNewSessionMode,
    startNewSession,
  } = useWorkspaceSessions(workspaceId, { enabled: !isCreateMode });

  const { repos, isLoading: isReposLoading } = useWorkspaceRepo(workspaceId, {
    enabled: !isCreateMode,
  });

  // TODO: Support multiple repos - currently only fetches comments from the primary repo.
  const primaryRepoId = repos[0]?.id;

  const currentWorkspaceSummary = activeWorkspaces.find(
    (w) => w.id === workspaceId
  );
  const hasPrAttached = !!currentWorkspaceSummary?.prStatus;

  const {
    gitHubComments,
    isGitHubCommentsLoading,
    showGitHubComments,
    setShowGitHubComments,
    getGitHubCommentsForFile,
    getGitHubCommentCountForFile,
    getFilesWithGitHubComments,
    getFirstCommentLineForFile,
  } = useGitHubComments({
    workspaceId,
    repoId: primaryRepoId,
    enabled: !isCreateMode && hasPrAttached,
  });

  // When the Changes view is scoped to a single commit, swap the live worktree
  // diff stream for that commit's (immutable) diff. The live stream is paused
  // while a commit is selected so we don't hold an idle socket open.
  const selectedCommit = useSelectedCommit(workspaceId);

  const { diffs: liveDiffs } = useDiffStream(
    workspaceId ?? null,
    !isCreateMode && !selectedCommit
  );

  const { data: commitDiffs } = useCommitDiff(
    workspaceId,
    selectedCommit?.repoId,
    selectedCommit?.sha,
    !isCreateMode && !!selectedCommit
  );

  const diffs: Diff[] = selectedCommit
    ? (commitDiffs ?? EMPTY_DIFFS)
    : liveDiffs;

  const diffPaths = useMemo(
    () =>
      new Set(diffs.map((d) => d.newPath || d.oldPath || '').filter(Boolean)),
    [diffs]
  );

  const diffStats: DiffStats = useMemo(
    () => ({
      files_changed: diffs.length,
      lines_added: diffs.reduce((sum, d) => sum + (d.additions ?? 0), 0),
      lines_removed: diffs.reduce((sum, d) => sum + (d.deletions ?? 0), 0),
    }),
    [diffs]
  );

  const rafRef = useRef<number | null>(null);
  const batchCountRef = useRef(0);

  const latestDiffDataRef = useRef({
    diffs,
    diffPaths,
    diffStats,
    gitHubComments,
    isGitHubCommentsLoading,
    showGitHubComments,
    setShowGitHubComments,
    getGitHubCommentsForFile,
    getGitHubCommentCountForFile,
    getFilesWithGitHubComments,
    getFirstCommentLineForFile,
  });
  latestDiffDataRef.current = {
    diffs,
    diffPaths,
    diffStats,
    gitHubComments,
    isGitHubCommentsLoading,
    showGitHubComments,
    setShowGitHubComments,
    getGitHubCommentsForFile,
    getGitHubCommentCountForFile,
    getFilesWithGitHubComments,
    getFirstCommentLineForFile,
  };

  useEffect(() => {
    batchCountRef.current++;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        batchCountRef.current = 0;
        useWorkspaceDiffStore
          .getState()
          .setWorkspaceDiffData(latestDiffDataRef.current);
      });
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [
    diffs,
    diffPaths,
    diffStats,
    gitHubComments,
    isGitHubCommentsLoading,
    showGitHubComments,
    setShowGitHubComments,
    getGitHubCommentsForFile,
    getGitHubCommentCountForFile,
    getFilesWithGitHubComments,
    getFirstCommentLineForFile,
  ]);

  useEffect(() => {
    return () => {
      useWorkspaceDiffStore.getState().clearWorkspaceDiffData();
    };
  }, []);

  const isLoading = isLoadingList || isLoadingWorkspace;

  useEffect(() => {
    if (!workspaceId || isCreateMode) return;

    workspacesApi
      .markSeen(workspaceId)
      .then(async () => {
        // Patch the summary caches in place instead of invalidating them:
        // invalidation refetched BOTH summary lists on every navigation, and
        // the 15s refetchInterval already reconciles everything else. Cancel
        // any in-flight summaries fetch first — its response predates
        // markSeen and would clobber the patch, resurrecting the unseen
        // badge on the workspace being viewed.
        await queryClient
          .cancelQueries({ queryKey: workspaceSummaryKeys.all })
          .catch(() => {});
        const clearUnseen = (archived: boolean) => {
          queryClient.setQueryData<Map<string, WorkspaceSummary>>(
            workspaceSummaryKeys.byArchived(archived, hostId),
            (old) => {
              const current = old?.get(workspaceId);
              if (!old || !current?.has_unseen_turns) return old;
              const next = new Map(old);
              next.set(workspaceId, { ...current, has_unseen_turns: false });
              return next;
            }
          );
        };
        clearUnseen(false);
        clearUnseen(true);
      })
      .catch((error) => {
        console.warn('Failed to mark workspace as seen:', error);
      });
  }, [workspaceId, isCreateMode, queryClient, hostId]);

  const selectWorkspace = useCallback(
    (id: string) => {
      appNavigation.goToWorkspace(id);
    },
    [appNavigation]
  );

  const navigateToCreate = useMemo(
    () => () => {
      appNavigation.goToWorkspacesCreate();
    },
    [appNavigation]
  );

  const coreValue = useMemo(
    () => ({
      workspaceId,
      workspace,
      activeWorkspaces,
      archivedWorkspaces,
      isWorkspacesListLoading: isLoadingList,
      isLoading,
      isCreateMode,
      selectWorkspace,
      navigateToCreate,
      sessions,
      selectedSession,
      selectedSessionId,
      selectSession,
      selectLatestSession,
      isSessionsLoading,
      isNewSessionMode,
      startNewSession,
      repos,
      isReposLoading,
    }),
    [
      workspaceId,
      workspace,
      activeWorkspaces,
      archivedWorkspaces,
      isLoadingList,
      isLoading,
      isCreateMode,
      selectWorkspace,
      navigateToCreate,
      sessions,
      selectedSession,
      selectedSessionId,
      selectSession,
      selectLatestSession,
      isSessionsLoading,
      isNewSessionMode,
      startNewSession,
      repos,
      isReposLoading,
    ]
  );

  return (
    <WorkspaceContext.Provider value={coreValue}>
      {children}
    </WorkspaceContext.Provider>
  );
}
