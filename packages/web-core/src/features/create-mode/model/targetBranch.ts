import type { LinkedIssue } from '@/shared/types/createMode';
import {
  gitBranchId,
  renderBranchTemplate,
  validateBranchName,
  type BranchNameError,
} from '@/features/create-mode/model/workingBranch';

export type { BranchNameError };
export { validateBranchName };

/**
 * How the per-repo target ("feature") branch is set up. Mirrors the working
 * branch modes, but scoped per repo:
 * - `existing`: use an existing branch as the base (must already exist).
 * - `new`: create a branch with an explicit name, forked from the repo's
 *   default branch when missing (reused if it already exists).
 * - `auto`: same as `new`, but the name is derived from the configured target
 *   branch prefix + template (and the linked issue).
 */
export type TargetBranchMode = 'existing' | 'new' | 'auto';

export const DEFAULT_TARGET_BRANCH_MODE: TargetBranchMode = 'existing';

/** `new`/`auto` create the branch off the repo default; `existing` reuses. */
export function targetBranchModeCreates(mode: TargetBranchMode): boolean {
  return mode !== 'existing';
}

/**
 * Build the auto-generated feature branch name from the configured prefix +
 * template. The template ({issueNumber}/{issueTitle}) is rendered from the
 * linked issue; when it yields nothing, `fallbackSlugSource` (e.g. the
 * workspace name) is slugged instead. Returns `null` when no name can be
 * derived, so the caller can fall back to another mode.
 */
export function resolveAutoTargetBranchName(
  prefix: string,
  template: string,
  issue: Pick<LinkedIssue, 'simpleId' | 'title'> | null,
  fallbackSlugSource?: string | null
): string | null {
  let slug = '';
  if (issue?.simpleId && template.trim()) {
    slug = renderBranchTemplate(template, {
      issueNumber: issue.simpleId,
      issueTitle: issue.title,
    });
  }
  if (!slug && fallbackSlugSource) {
    slug = gitBranchId(fallbackSlugSource);
  }
  if (!slug) return null;

  const cleanPrefix = prefix.trim().replace(/\/+$/g, '');
  return cleanPrefix ? `${cleanPrefix}/${slug}` : slug;
}
