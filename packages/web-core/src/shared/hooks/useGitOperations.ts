import { useRebase } from '@/shared/hooks/useRebase';
import { useMerge } from '@/shared/hooks/useMerge';
import { useCommit } from '@/shared/hooks/useCommit';
import { usePush } from '@/shared/hooks/usePush';
import { useForcePush } from '@/shared/hooks/useForcePush';
import { usePull } from '@/shared/hooks/usePull';
import { useUpdateFromBase } from '@/shared/hooks/useUpdateFromBase';
import { useChangeTargetBranch } from '@/shared/hooks/useChangeTargetBranch';
import { useGitOperationsError } from '@/shared/hooks/GitOperationsContext';
import { Result } from '@/shared/lib/api';
import type { GitOperationError, PushWorkspaceRequest } from 'shared/types';
import { ForcePushDialog } from '@/shared/dialogs/command-bar/ForcePushDialog';

export function useGitOperations(
  workspaceId: string | undefined,
  repoId: string | undefined
) {
  const { setError } = useGitOperationsError();

  const rebase = useRebase(
    workspaceId,
    repoId,
    () => setError(null),
    (err: Result<void, GitOperationError>) => {
      if (!err.success) {
        const data = err?.error;
        const isConflict =
          data?.type === 'merge_conflicts' ||
          data?.type === 'rebase_in_progress';
        if (!isConflict) {
          setError(err.message || 'Failed to rebase');
        }
      }
    }
  );

  const merge = useMerge(
    workspaceId,
    () => setError(null),
    (err: unknown) => {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'Failed to merge';
      setError(message);
    }
  );

  const commit = useCommit(
    workspaceId,
    () => setError(null),
    (err: unknown) => {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'Failed to commit';
      setError(message);
    }
  );

  const forcePush = useForcePush(
    workspaceId,
    () => setError(null),
    (err: unknown) => {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'Failed to force push';
      setError(message);
    }
  );

  const push = usePush(
    workspaceId,
    () => setError(null),
    async (err: unknown, errorData, params?: PushWorkspaceRequest) => {
      // Handle typed push errors
      if (errorData?.type === 'force_push_required') {
        // Show confirmation dialog - dialog handles the force push internally
        if (workspaceId && params?.repo_id) {
          await ForcePushDialog.show({ workspaceId, repoId: params.repo_id });
        }
        return;
      }

      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'Failed to push';
      setError(message);
    }
  );

  const pull = usePull(
    workspaceId,
    () => setError(null),
    (err: unknown) => {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'Failed to pull';
      setError(message);
    }
  );

  const updateFromBase = useUpdateFromBase(
    workspaceId,
    repoId,
    () => setError(null),
    (err: Result<void, GitOperationError>) => {
      if (!err.success) {
        const data = err?.error;
        // Conflicts surface via branch status (merge/rebase in progress); don't
        // also raise them as a generic error banner.
        const isConflict =
          data?.type === 'merge_conflicts' ||
          data?.type === 'rebase_in_progress';
        if (!isConflict) {
          setError(err.message || 'Failed to update from base');
        }
      }
    }
  );

  const changeTargetBranch = useChangeTargetBranch(
    workspaceId,
    repoId,
    () => setError(null),
    (err: unknown) => {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : 'Failed to change target branch';
      setError(message);
    }
  );

  const isAnyLoading =
    rebase.isPending ||
    merge.isPending ||
    commit.isPending ||
    push.isPending ||
    forcePush.isPending ||
    pull.isPending ||
    updateFromBase.isPending ||
    changeTargetBranch.isPending;

  return {
    actions: {
      rebase: rebase.mutateAsync,
      merge: merge.mutateAsync,
      commit: commit.mutateAsync,
      push: push.mutateAsync,
      forcePush: forcePush.mutateAsync,
      pull: pull.mutateAsync,
      updateFromBase: updateFromBase.mutateAsync,
      changeTargetBranch: changeTargetBranch.mutateAsync,
    },
    isAnyLoading,
    states: {
      rebasePending: rebase.isPending,
      mergePending: merge.isPending,
      commitPending: commit.isPending,
      pushPending: push.isPending,
      forcePushPending: forcePush.isPending,
      pullPending: pull.isPending,
      updateFromBasePending: updateFromBase.isPending,
      changeTargetBranchPending: changeTargetBranch.isPending,
    },
  };
}
