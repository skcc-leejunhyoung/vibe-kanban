import type { DiffStats } from 'shared/types';

/**
 * Backup poll for the workspace git queries (branch status, commit list).
 *
 * They used to poll every 5s from six call sites just to notice an agent
 * commit. The workspace diff stream already reports that, so polling is only
 * the safety net for a change no stream and no mutation reported (a commit
 * made in an external terminal, or a diff burst that never settles).
 */
export const WORKSPACE_GIT_BACKUP_POLL_MS = 60_000;

/**
 * How long the diff stream must be quiet before the git queries refetch.
 * An active agent rewrites files continuously; refetching per patch would be
 * worse than the poll it replaces.
 */
export const GIT_EVENT_SETTLE_MS = 1_500;

/** Compact identity of the worktree diff — changes on every edit or commit. */
export function workspaceDiffSignature(stats: DiffStats): string {
  return `${stats.files_changed}:${stats.lines_added}:${stats.lines_removed}`;
}
