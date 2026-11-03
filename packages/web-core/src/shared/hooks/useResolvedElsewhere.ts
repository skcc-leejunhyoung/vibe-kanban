import { useEffect, useRef, useState } from 'react';
import type { PrMerge, RepoBranchStatus } from 'shared/types';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';

/**
 * A dialog about a git situation (diverged branch, conflicts, a pull request
 * that could not be opened) closes by itself once that situation is gone:
 * another session or the Autopilot, acting on the same `git.operation_failed`
 * event, has handled it. The dialog shows a short note first so the user
 * knows why it went away.
 */

/** While such a dialog is open it re-reads the branch status this often (the backup poll is a minute). */
export const RESOLVED_ELSEWHERE_POLL_MS = 5_000;
/** How long the "handled elsewhere" note stays before the dialog closes itself. */
export const RESOLVED_ELSEWHERE_CLOSE_MS = 3_000;

/** The remote has no commit the local branch lacks any more. */
export function divergenceResolved(
  status: RepoBranchStatus,
  isTarget = false
): boolean {
  const behind = isTarget
    ? status.target_remote_commits_behind
    : status.remote_commits_behind;
  return behind === 0;
}

/** No conflicted files and no rebase in progress. */
export function conflictsResolved(status: RepoBranchStatus): boolean {
  return status.conflicted_files.length === 0 && !status.is_rebase_in_progress;
}

/**
 * An open pull request that was not there when the dialog opened, for
 * `headBranch` (empty = the work branch; rows without a head are legacy
 * work-branch PRs).
 */
export function openPrAppeared(
  status: RepoBranchStatus,
  baseline: RepoBranchStatus | undefined,
  headBranch: string | null
): PrMerge | undefined {
  const known = new Set(
    (baseline?.merges ?? [])
      .filter((merge) => merge.type === 'pr')
      .map((merge) => merge.id)
  );
  return status.merges.find(
    (merge): merge is { type: 'pr' } & PrMerge =>
      merge.type === 'pr' &&
      merge.pr_info.status === 'open' &&
      !known.has(merge.id) &&
      (!headBranch ||
        !merge.head_branch_name ||
        merge.head_branch_name === headBranch)
  );
}

export function useResolvedElsewhere({
  workspaceId,
  repoId,
  hostId,
  enabled,
  isResolved,
  onResolved,
}: {
  workspaceId: string;
  repoId: string;
  /** `undefined` = the host from context, like `useBranchStatus`. */
  hostId?: string | null;
  /** False while the dialog is hidden or running its own action. */
  enabled: boolean;
  /** `baseline` is the status known when the dialog opened (tells a new PR from an old one). */
  isResolved: (
    status: RepoBranchStatus,
    baseline: RepoBranchStatus | undefined
  ) => boolean;
  /** Called once, `RESOLVED_ELSEWHERE_CLOSE_MS` after the note appears. */
  onResolved: () => void;
}): boolean {
  const { data, dataUpdatedAt } = useBranchStatus(workspaceId, hostId, {
    refetchInterval: enabled ? RESOLVED_ELSEWHERE_POLL_MS : undefined,
  });
  const openedAt = useRef(0);
  const baseline = useRef<RepoBranchStatus | undefined>(undefined);
  const [resolved, setResolved] = useState(false);
  const callbacks = useRef({ isResolved, onResolved });
  callbacks.current = { isResolved, onResolved };

  // (Re)opening forgets the previous verdict and starts from what is known now.
  useEffect(() => {
    if (!enabled) return;
    openedAt.current = Date.now();
    baseline.current = undefined;
    setResolved(false);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || resolved || !data) return;
    const status = data.find((repo) => repo.repo_id === repoId);
    if (!status) return;
    // The cached status (or the first read) is what the dialog was opened on.
    if (baseline.current === undefined) baseline.current = status;
    // Only a read taken after the dialog opened can say the situation is over;
    // the cache may still describe the state before the failure.
    if (dataUpdatedAt <= openedAt.current) return;
    if (callbacks.current.isResolved(status, baseline.current)) {
      setResolved(true);
    }
  }, [enabled, resolved, data, dataUpdatedAt, repoId]);

  useEffect(() => {
    if (!resolved) return;
    const timer = setTimeout(
      () => callbacks.current.onResolved(),
      RESOLVED_ELSEWHERE_CLOSE_MS
    );
    return () => clearTimeout(timer);
  }, [resolved]);

  return resolved;
}
