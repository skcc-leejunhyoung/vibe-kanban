import { useState, useCallback, useMemo, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { workspacesApi } from '@/shared/lib/api';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { PullFirstDialog } from '@/shared/dialogs/command-bar/PullFirstDialog';
import { PrPanel, type PrInfo } from '@vibe/ui/components/PrPanel';
import type { Workspace, RepoWithTargetBranch, Merge } from 'shared/types';

export interface PrPanelContainerProps {
  selectedWorkspace: Workspace | undefined;
  repos: RepoWithTargetBranch[];
}

type OpState = 'idle' | 'pending';

/**
 * Whether a workspace has at least one linked PR (open, merged, or closed)
 * across its repos — used by the sidebar to show the "Pull Requests" section.
 */
export function hasLinkedPr(
  branchStatus: { merges?: Merge[] | null }[] | undefined
): boolean {
  return (
    branchStatus?.some((s) => s.merges?.some((m) => m.type === 'pr')) ?? false
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
  const [pullStates, setPullStates] = useState<Record<string, OpState>>({});

  // Reset transient op state when switching workspaces so a spinner doesn't leak
  // across repos that share the same id.
  useEffect(() => {
    setFetchStates({});
    setPushStates({});
    setPullStates({});
  }, [workspaceId]);

  const prs: PrInfo[] = useMemo(() => {
    if (!branchStatus) return [];
    const list: PrInfo[] = [];
    for (const repo of repos) {
      const status = branchStatus.find((s) => s.repo_id === repo.id);
      if (!status?.merges) continue;
      // Prefer an open PR; otherwise fall back to the most recent linked PR
      // (merged/closed) so the panel keeps showing the PR after it's merged.
      const pr =
        status.merges.find(
          (m: Merge) => m.type === 'pr' && m.pr_info.status === 'open'
        ) ?? status.merges.find((m: Merge) => m.type === 'pr');
      if (!pr || pr.type !== 'pr') continue;

      const isOpen = pr.pr_info.status === 'open';
      const headBranch =
        pr.head_branch_name ?? selectedWorkspace?.branch ?? '(work)';
      // In the three-branch flow the head IS the workspace's target branch, so
      // the existing target-branch push/fetch and its origin status apply to the
      // head directly. When the head is the work branch (two-branch flow) we
      // read the work branch's own remote status and leave push to the ⋮ menu.
      const headIsTarget = headBranch === repo.target_branch;
      const headRemoteBehind = headIsTarget
        ? (status.target_remote_commits_behind ?? 0)
        : (status.remote_commits_behind ?? 0);

      list.push({
        repoId: repo.id,
        repoName: repo.display_name || repo.name,
        prNumber: Number(pr.pr_info.number),
        prUrl: pr.pr_info.url ?? undefined,
        prStatus: pr.pr_info.status,
        headBranch,
        baseBranch: pr.target_branch_name,
        headRemoteAhead: headIsTarget
          ? (status.target_remote_commits_ahead ?? 0)
          : (status.remote_commits_ahead ?? 0),
        headRemoteBehind,
        prAhead: pr.head_commits_ahead ?? undefined,
        prBehind: pr.head_commits_behind ?? undefined,
        // Push/pull only apply to an open PR whose head is the workspace target
        // branch (three-branch case); merged/closed PRs are read-only.
        canPush: isOpen && headIsTarget && !status.is_target_remote,
        canPull: isOpen && headIsTarget && headRemoteBehind > 0,
        isFetching: fetchStates[repo.id] === 'pending',
        isPushing: pushStates[repo.id] === 'pending',
        isPulling: pullStates[repo.id] === 'pending',
      });
    }
    return list;
  }, [
    branchStatus,
    repos,
    selectedWorkspace,
    fetchStates,
    pushStates,
    pullStates,
  ]);

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
        if (!result.success && result.error?.type === 'diverged') {
          const choice = await PullFirstDialog.show({
            workspaceId,
            repoId,
            ahead: result.error.ahead,
            behind: result.error.behind,
            isTarget: true,
          });
          if (choice !== 'force') return;

          const confirm = await ConfirmDialog.show({
            title: t('git.states.forcePush'),
            message: t('git.targetPush.forceConfirm'),
            confirmText: t('git.states.forcePush'),
            variant: 'destructive',
          });
          if (confirm !== 'confirmed') return;
          result = await workspacesApi.pushTargetBranch(
            workspaceId,
            repoId,
            true
          );
        }
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

  // Fetch, then fast-forward the head (target) branch from origin (ff-only).
  const handlePull = useCallback(
    async (repoId: string) => {
      if (!workspaceId || pullStates[repoId] === 'pending') return;
      setPullStates((prev) => ({ ...prev, [repoId]: 'pending' }));
      try {
        await workspacesApi.pullTargetBranch(workspaceId, repoId);
        queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        });
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Failed to pull');
      } finally {
        setPullStates((prev) => ({ ...prev, [repoId]: 'idle' }));
      }
    },
    [workspaceId, pullStates, queryClient, showError]
  );

  return (
    <PrPanel
      prs={prs}
      onFetch={handleFetch}
      onPush={handlePush}
      onPull={handlePull}
    />
  );
}
