import type { WorkingBranchInput } from 'shared/types';
import type { LinkedIssue } from '@/shared/types/createMode';

/**
 * Port of the backend `git_branch_id` (crates/utils/src/text.rs): lowercase,
 * replace runs of non-alphanumerics with hyphens, trim hyphens, cap at 16
 * chars. Keeps the issue-template preview identical to the auto-generated
 * backend name.
 */
export function gitBranchId(input: string): string {
  const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const trimmed = slug.replace(/^-+|-+$/g, '');
  const cut = Array.from(trimmed).slice(0, 16).join('');
  return cut.replace(/-+$/g, '');
}

export interface BranchTemplateVars {
  issueNumber?: string | null;
  issueTitle?: string | null;
  shortId?: string | null;
}

/**
 * Render a working-branch-name template. `{issueTitle}` is sanitized via
 * {@link gitBranchId}; `{issueNumber}` / `{shortId}` are inserted as-is.
 * Collapses repeated/edge hyphens while preserving `/` path separators.
 */
export function renderBranchTemplate(
  template: string,
  vars: BranchTemplateVars
): string {
  const replaced = template
    .replace(/\{issueNumber\}/g, vars.issueNumber ?? '')
    .replace(
      /\{issueTitle\}/g,
      vars.issueTitle ? gitBranchId(vars.issueTitle) : ''
    )
    .replace(/\{shortId\}/g, vars.shortId ?? '');
  return replaced.replace(/-{2,}/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * The branch name the "auto" mode produces from a linked issue, or `null` when
 * there is no issue or the template is empty (the backend then falls back to
 * `vk/{uuid}-{name}`).
 */
export function resolveAutoWorkingBranchName(
  template: string,
  issue: Pick<LinkedIssue, 'simpleId' | 'title'> | null
): string | null {
  if (!issue?.simpleId || !template.trim()) return null;
  const name = renderBranchTemplate(template, {
    issueNumber: issue.simpleId,
    issueTitle: issue.title,
  });
  return name || null;
}

/** UI selection state for the working branch. Mirrors `WorkingBranchInput`. */
export type WorkingBranchSelection = WorkingBranchInput;

export const AUTO_WORKING_BRANCH: WorkingBranchSelection = { mode: 'auto' };

/**
 * Convert the UI selection into the request payload, expanding "auto" into a
 * concrete issue-based name when a linked issue is present.
 */
export function toWorkingBranchInput(
  selection: WorkingBranchSelection,
  template: string,
  issue: Pick<LinkedIssue, 'simpleId' | 'title'> | null
): WorkingBranchInput {
  if (selection.mode === 'auto') {
    const name = resolveAutoWorkingBranchName(template, issue);
    return name ? { mode: 'new', name } : { mode: 'auto' };
  }
  return selection;
}

export type BranchNameError = 'empty' | 'invalidChars' | 'invalidSequence';

/**
 * Validate a free-form working branch name (subset of `git check-ref-format`),
 * matching the prefix validation in GeneralSettingsSection. Returns an error
 * key or `null` when valid.
 */
export function validateBranchName(name: string): BranchNameError | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  // eslint-disable-next-line no-control-regex
  if (/[ \t~^:?*[\]\\\x00-\x1f\x7f]/.test(trimmed)) return 'invalidChars';
  if (
    trimmed.includes('..') ||
    trimmed.includes('@{') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.startsWith('.') ||
    trimmed.endsWith('.lock')
  )
    return 'invalidSequence';
  return null;
}
