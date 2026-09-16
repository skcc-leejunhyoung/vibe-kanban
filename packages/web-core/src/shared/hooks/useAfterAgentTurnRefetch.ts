import { useContext, useEffect, useRef } from 'react';
import { ExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';

/**
 * Delays applied after an agent turn goes terminal before re-reading.
 *
 * The server finishes the turn in two steps: `handle_execution_exit` publishes
 * the completion patch, and only then does the same block write the state that
 * depends on it — `try_commit_changes` for the auto-commit,
 * `maybe_schedule_rate_limit_resume` for a pending auto-resume. Reading at the
 * transition itself would return the pre-write state. Two shots: one for the
 * normal case, a later one for a repo where the work takes a while. Slower than
 * that falls through to whatever backup poll the query keeps.
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
 * Re-read a query once the session's agent turn has finished.
 *
 * For git state this is the commit trigger that the diff stream cannot be:
 * that stream diffs the worktree against the merge-base with the target
 * branch, so a commit on the workspace branch leaves its output byte-identical.
 *
 * Uses the context directly rather than `useExecutionProcessesContext` so
 * callers stay usable outside a provider (then only their backup poll runs).
 */
export function useAfterAgentTurnRefetch(
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
