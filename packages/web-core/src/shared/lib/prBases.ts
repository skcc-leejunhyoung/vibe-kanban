import { workspacesApi } from '@/shared/lib/api';
import { BranchPickerDialog } from '@/shared/dialogs/BranchPickerDialog';
import type { PrBase, PrBaseSelection, RepoBranchStatus } from 'shared/types';

/** Confirm every destination before starting anything; cancelling leaves all repos alone. */
export async function choosePrBases(
  workspaceId: string,
  hostId?: string | null,
  options: { afterMerge?: boolean; repoId?: string; saved?: PrBase[] } = {}
): Promise<PrBaseSelection[] | null> {
  const [workspace, repos, statuses] = await Promise.all([
    workspacesApi.get(workspaceId, hostId),
    workspacesApi.getRepos(workspaceId, hostId),
    workspacesApi.getBranchStatus(workspaceId, hostId),
  ]);
  const bases: PrBaseSelection[] = [];
  for (const repo of repos.filter(
    (r) => !options.repoId || r.id === options.repoId
  )) {
    const status = statuses.find((s) => s.repo_id === repo.id);
    const merged = status?.merges.find((m) => m.type === 'direct');
    const head = options.afterMerge
      ? merged?.type === 'direct'
        ? merged.target_branch_name
        : workspace.branch
      : (predictedPrHead(status, repo.target_branch) ?? workspace.branch);
    const initial =
      options.saved?.find((b) => b.repo_id === repo.id)?.base_branch ??
      (head === workspace.branch
        ? repo.target_branch
        : repo.default_target_branch);
    const base = await BranchPickerDialog.show({
      repoId: repo.id,
      hostId,
      mode: 'prBase',
      repoDisplayName: repo.display_name,
      headBranch: head,
      initialBranch: initial,
    });
    if (!base) return null;
    if (base === head)
      throw new Error(
        'PR head and base must be different. Choose another PR base.'
      );
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
  const merged = merges.find((merge) => merge.type === 'direct');
  if (merged?.type === 'direct') return merged.target_branch_name;
  const hasOpenPr = merges.some(
    (merge) => merge.type === 'pr' && merge.pr_info.status === 'open'
  );
  return hasOpenPr ? null : targetBranch;
}
