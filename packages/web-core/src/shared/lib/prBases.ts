import i18n from '@/i18n/config';
import { workspacesApi } from '@/shared/lib/api';
import { BranchPickerDialog } from '@/shared/dialogs/BranchPickerDialog';
import type { PrBase, PrBaseSelection, RepoBranchStatus } from 'shared/types';

/** Confirm every destination before starting anything; cancelling leaves all repos alone. */
export async function choosePrBases(
  workspaceId: string,
  hostId?: string | null,
  options: { afterMerge?: boolean; repoId?: string; saved?: PrBase[] } = {}
): Promise<PrBaseSelection[] | null> {
  const repos = await workspacesApi.getRepos(workspaceId, hostId);
  const bases: PrBaseSelection[] = [];
  for (const repo of repos.filter(
    (r) => !options.repoId || r.id === options.repoId
  )) {
    const plan = await workspacesApi.getPrBranchPlan(
      workspaceId,
      {
        repo_id: repo.id,
        after_merge: !!options.afterMerge,
        base_branch: null,
      },
      hostId
    );
    const head = plan.head_branch;
    const initial =
      options.saved?.find((b) => b.repo_id === repo.id)?.base_branch ??
      plan.base_branch;
    const base = await BranchPickerDialog.show({
      repoId: repo.id,
      hostId,
      mode: 'prBase',
      repoDisplayName: repo.display_name,
      headBranch: head,
      initialBranch: initial,
    });
    if (!base) return null;
    const confirmed = await workspacesApi.getPrBranchPlan(
      workspaceId,
      {
        repo_id: repo.id,
        after_merge: !!options.afterMerge,
        base_branch: base,
      },
      hostId
    );
    if (confirmed.head_branch !== head) {
      throw new Error(i18n.t('tasks:prBase.headChanged'));
    }
    bases.push({ repo_id: repo.id, base_branch: base });
  }
  if (!bases.length)
    throw new Error('No repositories to create pull requests for');
  return bases;
}

/**
 * The head a repo's PR will have once the review has merged, as the server
 * picks it; `null` is the work branch itself. The work is merged into the
 * repo's target branch and the PR comes from there — unless the merge skips
 * the repo because it already has an open PR, which leaves the work branch.
 */
export function predictedPrHead(
  status: RepoBranchStatus | undefined,
  targetBranch: string
): string | null {
  const merges = status?.merges ?? [];
  const hasOpenPr = merges.some(
    (merge) => merge.type === 'pr' && merge.pr_info.status === 'open'
  );
  const merged = merges.find((merge) => merge.type === 'direct');
  if (merged?.type === 'direct' && (hasOpenPr || status?.commits_ahead === 0))
    return merged.target_branch_name;
  return hasOpenPr ? null : targetBranch;
}
