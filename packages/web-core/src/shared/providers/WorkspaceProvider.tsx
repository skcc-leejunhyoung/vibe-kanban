import {
  ReactNode,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getHostWorkspaceKey,
  UnifiedWorkspaceStreamsProvider,
  useUnifiedWorkspaces,
} from '@/shared/hooks/useWorkspaces';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import {
  useWorkspaceRecord,
  workspaceRecordKeys,
} from '@/shared/hooks/useWorkspaceRecord';
import {
  useWorkspaceRepo,
  workspaceRepoKeys,
} from '@/shared/hooks/useWorkspaceRepo';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { useWorkspaceSessions } from '@/shared/hooks/useWorkspaceSessions';
import { useGitHubComments } from '@/shared/hooks/useGitHubComments';
import { useDiffStream } from '@/shared/hooks/useDiffStream';
import { useCommitDiff } from '@/shared/hooks/useCommitDiff';
import { workspacesApi } from '@/shared/lib/api';
import {
  createWorkspaceDiffStore,
  WorkspaceDiffStoreProvider,
} from '@/shared/stores/useWorkspaceDiffStore';
import { useSelectedCommit } from '@/shared/stores/useChangesCommitStore';
import { useHostId } from '@/shared/providers/HostIdProvider';
import type { Diff, DiffStats, WorkspaceSummary } from 'shared/types';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';

import {
  WorkspaceContext,
  useWorkspaceContext,
} from '@/shared/hooks/useWorkspaceContext';

interface WorkspaceProviderProps {
  children: ReactNode;
  /**
   * Reuse the workspace list streams of an enclosing WorkspaceProvider
   * instead of mounting a new stream source. Split panes pass true — the
   * document-level provider already streams every host's workspace list, and
   * one source per document is the point of in-document panes.
   */
  inheritStreams?: boolean;
}

// Stable reference so an empty commit-diff result doesn't churn downstream memos.
const EMPTY_DIFFS: Diff[] = [];
const EMPTY_WORKSPACE_RECORDS = {};

type WorkspaceLists = Pick<
  ReturnType<typeof useUnifiedWorkspaces>,
  'workspaces' | 'archivedWorkspaces' | 'workspaceRecordsById' | 'isLoading'
>;

function WorkspaceProviderContent({
  children,
  lists,
}: WorkspaceProviderProps & { lists: WorkspaceLists }) {
  const appNavigation = useAppNavigation();
  const currentDestination = useCurrentAppDestination();
  const queryClient = useQueryClient();
  const hostId = useHostId();
  // Derived from the destination (not router params) so split panes can scope
  // this provider by overriding the destination for their subtree.
  const workspaceId =
    currentDestination && 'workspaceId' in currentDestination
      ? currentDestination.workspaceId
      : undefined;
  // One diff store per provider instance so coexisting panes don't clobber
  // each other's diff data.
  const [diffStore] = useState(createWorkspaceDiffStore);

  const isCreateMode = currentDestination?.kind === 'workspaces-create';

  const {
    workspaces: activeWorkspaces,
    archivedWorkspaces,
    workspaceRecordsById,
    isLoading: isLoadingList,
  } = lists;

  const { data: workspace, isLoading: isLoadingWorkspace } = useWorkspaceRecord(
    workspaceId,
    {
      enabled: !!workspaceId && !isCreateMode,
      // The list stream usually already has this workspace's row; serving it
      // as placeholder paints the page instantly instead of a full-pane
      // spinner while the record query fetches.
      placeholderData: workspaceId
        ? workspaceRecordsById[getHostWorkspaceKey(workspaceId, hostId)]
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
    (workspace) =>
      getHostWorkspaceKey(workspace.id, workspace.hostId) ===
      getHostWorkspaceKey(workspaceId ?? '', hostId)
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
    gitHubCommentsRepoId: primaryRepoId ?? null,
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
    gitHubCommentsRepoId: primaryRepoId ?? null,
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
        diffStore.getState().setWorkspaceDiffData(latestDiffDataRef.current);
      });
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [
    diffStore,
    diffs,
    diffPaths,
    diffStats,
    gitHubComments,
    primaryRepoId,
    isGitHubCommentsLoading,
    showGitHubComments,
    setShowGitHubComments,
    getGitHubCommentsForFile,
    getGitHubCommentCountForFile,
    getFilesWithGitHubComments,
    getFirstCommentLineForFile,
  ]);

  const isLoading = isLoadingList || isLoadingWorkspace;

  useEffect(() => {
    if (!workspaceId || isCreateMode) return;

    workspacesApi
      .markSeen(workspaceId, hostId)
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
    (id: string, destinationHostId?: string | null) => {
      appNavigation.goToWorkspace(id, { hostId: destinationHostId });
    },
    [appNavigation]
  );

  // Recovery path when a transient failure left the pane without data (the
  // record/session queries have no visible retry otherwise).
  const reloadWorkspace = useCallback(() => {
    if (!workspaceId) return;
    void queryClient.invalidateQueries({
      queryKey: workspaceRecordKeys.byId(workspaceId, hostId),
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceRepoKeys.byWorkspace(workspaceId, hostId),
    });
  }, [queryClient, workspaceId, hostId]);

  const navigateToCreate = useMemo(
    () => (destinationHostId?: string | null) => {
      appNavigation.goToWorkspacesCreate({ hostId: destinationHostId });
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
      reloadWorkspace,
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
      reloadWorkspace,
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
    <WorkspaceDiffStoreProvider value={diffStore}>
      <WorkspaceContext.Provider value={coreValue}>
        {children}
      </WorkspaceContext.Provider>
    </WorkspaceDiffStoreProvider>
  );
}

function WorkspaceProviderWithOwnStreams({
  children,
}: {
  children: ReactNode;
}) {
  const lists = useUnifiedWorkspaces();
  return (
    <WorkspaceProviderContent lists={lists}>
      {children}
    </WorkspaceProviderContent>
  );
}

function WorkspaceProviderWithInheritedStreams({
  children,
}: {
  children: ReactNode;
}) {
  const parent = useWorkspaceContext();
  const lists = useMemo<WorkspaceLists>(
    () => ({
      workspaces: parent.activeWorkspaces,
      archivedWorkspaces: parent.archivedWorkspaces,
      workspaceRecordsById: EMPTY_WORKSPACE_RECORDS,
      isLoading: parent.isWorkspacesListLoading,
    }),
    [
      parent.activeWorkspaces,
      parent.archivedWorkspaces,
      parent.isWorkspacesListLoading,
    ]
  );
  return (
    <WorkspaceProviderContent lists={lists}>
      {children}
    </WorkspaceProviderContent>
  );
}

export function WorkspaceProvider({
  children,
  inheritStreams = false,
}: WorkspaceProviderProps) {
  if (inheritStreams) {
    return (
      <WorkspaceProviderWithInheritedStreams>
        {children}
      </WorkspaceProviderWithInheritedStreams>
    );
  }
  return (
    <UnifiedWorkspaceStreamsProvider>
      <WorkspaceProviderWithOwnStreams>
        {children}
      </WorkspaceProviderWithOwnStreams>
    </UnifiedWorkspaceStreamsProvider>
  );
}
