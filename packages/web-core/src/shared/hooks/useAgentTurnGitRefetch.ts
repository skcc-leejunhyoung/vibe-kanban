import { useContext, useEffect, useRef } from 'react';
import { ExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';

/**
 * Delays applied after an agent turn goes terminal before re-reading git state.
 *
 * The turn's auto-commit runs *after* the execution process row already flipped
 * to terminal — `handle_execution_exit` publishes the completion patch, then
 * `handle_execution_post_completion` calls `try_commit_changes` — so reading at
 * the transition itself returns pre-commit state. Two shots: one for the normal
 * case, a later one for a repo where committing takes a while. Slower than that
 * falls through to WORKSPACE_GIT_BACKUP_POLL_MS.
 */
export const AGENT_TURN_SETTLE_MS = [2_000, 8_000];

/** True only on the running -> finished edge of an agent turn. */
export function agentTurnJustEnded(
  previous: boolean | undefined,
  current: boolean | undefined
): boolean {
  // `undefined` is "no ExecutionProcessesProvider above us" — never a turn edge.
  return previous === true && current === false;
}

/**
 * Re-read a workspace git query once the session's agent turn has finished.
 *
 * This is the commit trigger that the diff stream cannot be: that stream diffs
 * the worktree against the merge-base with the target branch, so a commit on
 * the workspace branch leaves its output byte-identical.
 *
 * Uses the context directly rather than `useExecutionProcessesContext` so the
 * git queries stay usable outside a provider (then only the backup poll runs).
 */
export function useAgentTurnGitRefetch(
  enabled: boolean,
  refetch: () => void
): void {
  const isAttemptRunning = useContext(
    ExecutionProcessesContext
  )?.isAttemptRunningAll;
  const wasRunningRef = useRef(isAttemptRunning);

  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = isAttemptRunning;
    if (!enabled || !agentTurnJustEnded(wasRunning, isAttemptRunning)) return;
    const timers = AGENT_TURN_SETTLE_MS.map((delay) =>
      setTimeout(refetch, delay)
    );
    return () => timers.forEach(clearTimeout);
  }, [enabled, isAttemptRunning, refetch]);
}
