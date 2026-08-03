import { workspacesApi } from '@/shared/lib/api';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import i18n from '@/i18n';

/**
 * Guard the "Create Pull Request" flows against silently publishing a work
 * branch that has never been pushed to origin.
 *
 * Opening a PR from the raw work branch (e.g. a `vk/*` worktree branch) pushes
 * it to the remote for the first time. That is usually unintended — the user
 * typically wants to merge into a feature branch first — so warn and let them
 * confirm before the push happens.
 *
 * `headBranch` is the effective PR source branch. A null/undefined/empty value
 * means the backend falls back to the workspace's work branch, which is exactly
 * the at-risk case. A feature-branch head is part of the intended three-branch
 * flow and is never flagged here.
 *
 * Returns `true` when it is safe to proceed (not the work branch, already on
 * the remote, remote state could not be determined, or the user confirmed),
 * and `false` only when the user explicitly cancels the warning.
 */
export async function confirmUnpushedWorkBranchPush(
  workspaceId: string,
  repoId: string,
  workBranch: string,
  headBranch?: string | null,
  hostId?: string | null
): Promise<boolean> {
  const effectiveHead = headBranch?.trim() || workBranch;
  // Only the work branch risks a first-time push here; a feature-branch head is
  // part of the intended workflow.
  if (effectiveHead !== workBranch) return true;

  let workBranchHasRemote: boolean | undefined;
  try {
    const branchStatus = await workspacesApi.getBranchStatus(
      workspaceId,
      hostId
    );
    workBranchHasRemote = branchStatus.find(
      (status) => status.repo_id === repoId
    )?.work_branch_has_remote;
  } catch {
    // If the remote state can't be determined, don't block the flow.
    return true;
  }

  // Already on the remote (or unknown repo) — pushing publishes nothing new.
  if (workBranchHasRemote !== false) return true;

  const result = await ConfirmDialog.show({
    title: i18n.t('tasks:createPrDialog.unpushedWorkBranch.title'),
    message: i18n.t('tasks:createPrDialog.unpushedWorkBranch.message', {
      branch: workBranch,
    }),
    confirmText: i18n.t('tasks:createPrDialog.unpushedWorkBranch.confirm'),
    cancelText: i18n.t('common:buttons.cancel'),
    variant: 'destructive',
  });
  return result === 'confirmed';
}
