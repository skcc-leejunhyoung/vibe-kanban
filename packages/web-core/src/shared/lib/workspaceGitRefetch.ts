import type { DiffStats } from 'shared/types';

/**
 * Backup poll for the workspace git queries (branch status, commit list).
 *
 * They used to poll every 5s from six call sites. Everything that normally
 * moves git state now has an event: explicit actions invalidate these keys,
 * worktree edits arrive on the diff stream, and the agent's auto-commit comes
 * in through useAgentTurnGitRefetch. Polling is only the safety net for what
 * none of those report — a `git commit` run in an external terminal, or a diff
 * burst that never settles.
 */
export const WORKSPACE_GIT_BACKUP_POLL_MS = 60_000;

/**
 * How long the diff stream must be quiet before the git queries refetch.
 * An active agent rewrites files continuously; refetching per patch would be
 * worse than the poll it replaces. Starvation is bounded by the backup poll.
 */
export const GIT_EVENT_SETTLE_MS = 1_500;

/** Compact identity of the worktree diff — changes on every edit or commit. */
export function workspaceDiffSignature(stats: DiffStats): string {
  return `${stats.files_changed}:${stats.lines_added}:${stats.lines_removed}`;
}
