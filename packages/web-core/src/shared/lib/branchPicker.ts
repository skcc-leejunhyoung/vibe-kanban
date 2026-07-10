import type { Repo } from 'shared/types';
import { BranchPickerDialog } from '@/shared/dialogs/BranchPickerDialog';

/**
 * Prompt the user to pick an existing branch for a repo. The dialog fetches
 * from origin on open so the list reflects the latest branches pushed to
 * origin, not just what was known locally at clone time. Returns the chosen
 * branch name, or `null` if the dialog was cancelled.
 *
 * Shared by the per-repo target-branch picker (CreateModeRepoPickerBar) and the
 * working-branch row (WorkingBranchRow).
 */
export async function pickBranchForRepo(repo: Repo): Promise<string | null> {
  return BranchPickerDialog.show({
    repoId: repo.id,
    mode: 'select',
    repoDisplayName: repo.display_name || repo.name,
  });
}
