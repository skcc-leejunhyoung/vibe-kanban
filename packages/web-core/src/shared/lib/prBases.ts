import i18n from '@/i18n/config';
import { repoApi, workspacesApi } from '@/shared/lib/api';
import { queryClient } from '@/shared/lib/queryClient';
import { BranchPickerDialog } from '@/shared/dialogs/BranchPickerDialog';
import type { PrBaseSelection, RepoBranchStatus } from 'shared/types';

/**
 * The PR destination for every repo, before anything starts. The configured
 * one is used without asking; only a repo without a usable default asks, and
 * the answer is saved as that repo's default target branch, as Settings does.
 * Cancelling leaves all repos alone.
 */
export async function choosePrBases(
  workspaceId: string,
  hostId?: string | null,
  options: { afterMerge?: boolean; repoId?: string } = {}
): Promise<PrBaseSelection[] | null> {
  const repos = await workspacesApi.getRepos(workspaceId, hostId);
  const bases: PrBaseSelection[] = [];
  const chosen: PrBaseSelection[] = [];
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
    // The server validates a configured base before any side effect.
    if (plan.base_branch && plan.base_branch !== head) {
      bases.push({ repo_id: repo.id, base_branch: plan.base_branch });
      continue;
    }
    const base = await BranchPickerDialog.show({
      repoId: repo.id,
      hostId,
      mode: 'prBase',
      repoDisplayName: repo.display_name,
      headBranch: head,
      initialBranch: plan.base_branch,
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
    chosen.push({ repo_id: repo.id, base_branch: base });
    bases.push({ repo_id: repo.id, base_branch: base });
  }
  if (!bases.length)
    throw new Error('No repositories to create pull requests for');
  for (const { repo_id, base_branch } of chosen) {
    await repoApi.update(
      repo_id,
      { default_target_branch: base_branch },
      hostId
    );
  }
  if (chosen.length)
    void queryClient.invalidateQueries({ queryKey: ['repos'] });
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
