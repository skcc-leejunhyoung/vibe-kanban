import { useState, useCallback, useMemo, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { workspacesApi } from '@/shared/lib/api';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { PrPanel, type PrInfo } from '@vibe/ui/components/PrPanel';
import type { Workspace, RepoWithTargetBranch, Merge } from 'shared/types';

export interface PrPanelContainerProps {
  selectedWorkspace: Workspace | undefined;
  repos: RepoWithTargetBranch[];
}

type OpState = 'idle' | 'pending';

/**
 * Whether a workspace has at least one open PR across its repos — used by the
 * sidebar to show the "Pull Requests" section only when relevant.
 */
export function hasOpenPr(
  branchStatus: { merges?: Merge[] | null }[] | undefined
): boolean {
  return (
    branchStatus?.some((s) =>
      s.merges?.some((m) => m.type === 'pr' && m.pr_info.status === 'open')
    ) ?? false
  );
}

export function PrPanelContainer({
  selectedWorkspace,
  repos,
}: PrPanelContainerProps) {
  const queryClient = useQueryClient();
  const { t } = useTranslation('tasks');
  const workspaceId = selectedWorkspace?.id;
  const { data: branchStatus } = useBranchStatus(workspaceId);

  const [fetchStates, setFetchStates] = useState<Record<string, OpState>>({});
  const [pushStates, setPushStates] = useState<Record<string, OpState>>({});

  // Reset transient op state when switching workspaces so a spinner doesn't leak
  // across repos that share the same id.
  useEffect(() => {
    setFetchStates({});
    setPushStates({});
  }, [workspaceId]);

  const prs: PrInfo[] = useMemo(() => {
    if (!branchStatus) return [];
    const list: PrInfo[] = [];
    for (const repo of repos) {
      const status = branchStatus.find((s) => s.repo_id === repo.id);
      if (!status?.merges) continue;
      const openPr = status.merges.find(
        (m: Merge) => m.type === 'pr' && m.pr_info.status === 'open'
      );
      if (!openPr || openPr.type !== 'pr') continue;

      const headBranch =
        openPr.head_branch_name ?? selectedWorkspace?.branch ?? '(work)';
      // In the three-branch flow the head IS the workspace's target branch, so
      // the existing target-branch push/fetch and its origin status apply to the
      // head directly. When the head is the work branch (two-branch flow) we
      // read the work branch's own remote status and leave push to the ⋮ menu.
      const headIsTarget = headBranch === repo.target_branch;

      list.push({
        repoId: repo.id,
        repoName: repo.display_name || repo.name,
        prNumber: Number(openPr.pr_info.number),
        prUrl: openPr.pr_info.url ?? undefined,
        headBranch,
        baseBranch: openPr.target_branch_name,
        headRemoteAhead: headIsTarget
          ? (status.target_remote_commits_ahead ?? 0)
          : (status.remote_commits_ahead ?? 0),
        headRemoteBehind: headIsTarget
          ? (status.target_remote_commits_behind ?? 0)
          : (status.remote_commits_behind ?? 0),
        prAhead: openPr.head_commits_ahead ?? undefined,
        prBehind: openPr.head_commits_behind ?? undefined,
        // Surface push only when the head is the workspace target branch (the
        // three-branch case); then target-branch push == head push. Otherwise
        // push stays reachable via the ⋮ menu.
        canPush: headIsTarget && !status.is_target_remote,
        isFetching: fetchStates[repo.id] === 'pending',
        isPushing: pushStates[repo.id] === 'pending',
      });
    }
    return list;
  }, [branchStatus, repos, selectedWorkspace, fetchStates, pushStates]);

  const showError = useCallback((message: string) => {
    ConfirmDialog.show({
      title: 'Error',
      message,
      confirmText: 'OK',
      showCancelButton: false,
      variant: 'destructive',
    });
  }, []);

  // Fetch the repo's primary remote (refreshes both head and base tracking refs),
  // then refetch branch status so ahead/behind numbers update.
  const handleFetch = useCallback(
    async (repoId: string) => {
      if (!workspaceId || fetchStates[repoId] === 'pending') return;
      setFetchStates((prev) => ({ ...prev, [repoId]: 'pending' }));
      try {
        await workspacesApi.fetchTargetBranch(workspaceId, repoId);
        queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        });
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Failed to fetch');
      } finally {
        setFetchStates((prev) => ({ ...prev, [repoId]: 'idle' }));
      }
    },
    [workspaceId, fetchStates, queryClient, showError]
  );

  // Push the head (feature) branch to origin, confirming a force-push when the
  // remote has diverged. Mirrors the git panel's target-push flow.
  const handlePush = useCallback(
    async (repoId: string) => {
      if (!workspaceId || pushStates[repoId] === 'pending') return;
      setPushStates((prev) => ({ ...prev, [repoId]: 'pending' }));
      try {
        let result = await workspacesApi.pushTargetBranch(
          workspaceId,
          repoId,
          false
        );
        if (!result.success && result.error?.type === 'force_push_required') {
          const confirm = await ConfirmDialog.show({
            title: t('git.states.forcePush'),
            message: t('git.targetPush.forceConfirm'),
            confirmText: t('git.states.forcePush'),
            variant: 'destructive',
          });
          if (confirm !== 'confirmed') {
            setPushStates((prev) => ({ ...prev, [repoId]: 'idle' }));
            return;
          }
          result = await workspacesApi.pushTargetBranch(
            workspaceId,
            repoId,
            true
          );
        }
        if (!result.success) {
          throw new Error(result.message || 'Failed to push');
        }
        queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        });
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Failed to push');
      } finally {
        setPushStates((prev) => ({ ...prev, [repoId]: 'idle' }));
      }
    },
    [workspaceId, pushStates, queryClient, showError, t]
  );

  return <PrPanel prs={prs} onFetch={handleFetch} onPush={handlePush} />;
}
