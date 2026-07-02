import type { Diff, DiffChangeKind } from 'shared/types';

/**
 * Auto-collapse policy for the Changes view.
 *
 * The Changes view renders diffs fully (no line virtualization — see
 * ChangesPanelContainer), so the total rendered line count is what bounds
 * performance. Auto-collapsing large or low-signal files at first render keeps
 * that bounded: a huge file stays collapsed until the user opts in by expanding
 * it. Keep this in sync with that assumption — lowering the guard here is what
 * protects the non-virtualized render from pathological diffs.
 */

/** Change kinds that start collapsed regardless of size. */
export const COLLAPSE_BY_CHANGE_TYPE: Record<DiffChangeKind, boolean> = {
  added: false,
  deleted: true,
  modified: false,
  renamed: true,
  copied: true,
  permissionChange: true,
};

/** Line count (additions + deletions) above which a file starts collapsed. */
export const COLLAPSE_MAX_LINES = 800;

export function shouldAutoCollapse(diff: Diff): boolean {
  const totalLines = (diff.additions ?? 0) + (diff.deletions ?? 0);
  // A pure rename (no content change) or an oversized rename collapses; a
  // rename that also edits a reasonable amount of content stays expanded.
  if (diff.change === 'renamed') {
    return totalLines === 0 || totalLines > COLLAPSE_MAX_LINES;
  }
  if (COLLAPSE_BY_CHANGE_TYPE[diff.change]) return true;
  if (totalLines > COLLAPSE_MAX_LINES) return true;
  return false;
}
