import type { WorkingBranchInput } from 'shared/types';
import type { LinkedIssue } from '@/shared/types/createMode';

/**
 * Max length (in chars) of the slug derived from a title. Mirrors the backend
 * `MAX_BRANCH_SLUG_CHARS` (crates/utils/src/text.rs) so previews match the
 * generated name. Not a git limit — git only bounds branch names by the
 * filesystem's ~255-byte filename limit.
 */
export const MAX_BRANCH_SLUG_CHARS = 40;

/**
 * Port of the backend `git_branch_id` (crates/utils/src/text.rs): lowercase,
 * collapse runs of characters git can't use in a ref into hyphens, trim
 * hyphens, cap at {@link MAX_BRANCH_SLUG_CHARS} chars. `\p{L}`/`\p{N}` keep
 * Unicode letters and digits (e.g. Hangul) so non-ASCII titles survive. Keeps
 * the issue-template preview identical to the auto-generated backend name.
 */
export function gitBranchId(input: string): string {
  const slug = input.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-');
  const trimmed = slug.replace(/^-+|-+$/g, '');
  const cut = Array.from(trimmed).slice(0, MAX_BRANCH_SLUG_CHARS).join('');
  return cut.replace(/-+$/g, '');
}

export interface BranchTemplateVars {
  issueNumber?: string | null;
  issueTitle?: string | null;
}

/**
 * Render a working-branch-name template. `{issueTitle}` is sanitized via
 * {@link gitBranchId}; `{issueNumber}` is inserted as-is. Collapses
 * repeated/edge hyphens while preserving `/` path separators.
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
    );
  return replaced.replace(/-{2,}/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * The issue-template branch name suggested for the "new" mode, or `null` when
 * there is no linked issue or the template is empty. Offered as a one-click
 * suggestion; the `auto` mode itself defers to the backend's uuid-based name.
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

// NOTE: the UI selection is sent to the backend as-is — `auto` stays `auto`.
// The backend then generates a uuid-prefixed name (`{prefix}/{uuid}-{slug}`)
// that is always unique. Resolving the issue template into a concrete `new`
// name here would drop the uuid and make re-creating a workspace for the same
// issue collide, so the template is only offered as a suggestion when the user
// picks "new" mode (see WorkingBranchRow), never substituted for `auto`.

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
    trimmed === '@' ||
    trimmed.includes('//') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('.')
  )
    return 'invalidSequence';
  // `git check-ref-format` rules apply to each slash-separated component, not
  // just the whole string: no component may start with '.' or end with '.lock'.
  for (const component of trimmed.split('/')) {
    if (component.startsWith('.') || component.endsWith('.lock')) {
      return 'invalidSequence';
    }
  }
  return null;
}
