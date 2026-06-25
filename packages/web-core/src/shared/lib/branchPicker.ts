import type { Repo } from 'shared/types';
import { repoApi } from '@/shared/lib/api';
import {
  SelectionDialog,
  type SelectionPage,
} from '@/shared/dialogs/command-bar/SelectionDialog';
import {
  buildBranchSelectionPages,
  type BranchSelectionResult,
} from '@/shared/dialogs/command-bar/selections/branchSelection';

/**
 * Refresh a repo's branches from origin and prompt the user to pick one.
 * Returns the chosen branch name, or `null` if the dialog was cancelled.
 * Shared by the per-repo target-branch picker (CreateModeRepoPickerBar) and the
 * working-branch row (WorkingBranchRow).
 */
export async function pickBranchForRepo(repo: Repo): Promise<string | null> {
  // Fetch from the remote first so the list reflects the latest branches
  // pushed to origin, not just what was known locally at clone time.
  const branches = await repoApi.getBranches(repo.id, undefined, {
    fetch: true,
  });
  const result = (await SelectionDialog.show({
    initialPageId: 'selectBranch',
    pages: buildBranchSelectionPages(
      branches.map((b) => ({ name: b.name, isCurrent: b.is_current })),
      repo.display_name || repo.name
    ) as Record<string, SelectionPage>,
  })) as BranchSelectionResult | undefined;
  return result?.branch ?? null;
}
