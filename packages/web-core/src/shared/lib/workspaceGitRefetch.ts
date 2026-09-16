import type { DiffStats, RepoBranchStatus } from 'shared/types';

/**
 * Backup poll for the workspace git queries (branch status, commit list).
 *
 * They used to poll every 5s from six call sites. Everything that normally
 * moves git state now has an event: explicit actions invalidate these keys,
 * worktree edits arrive on the diff stream, and the agent's auto-commit comes
 * in through useAfterAgentTurnRefetch. Polling is only the safety net for what
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

/**
 * Compact identity of each repo's branch tip and ahead-of-base count.
 *
 * Every git action that changes the commit list moves one of these: a commit
 * or rebase moves `head_oid`, a merge or a target-branch change moves the
 * merge-base and so `commits_ahead`. Branch status is the one query every one
 * of those paths already invalidates, so deriving the commit list from it
 * covers them all — including the Git panel buttons, which dispatch `Actions.*`
 * rather than the mutation hooks.
 */
export function branchTipSignature(
  status: RepoBranchStatus[] | undefined
): string {
  if (!status) return '';
  return status
    .map((s) => `${s.repo_id}:${s.head_oid ?? ''}:${s.commits_ahead ?? ''}`)
    .join(';');
}
