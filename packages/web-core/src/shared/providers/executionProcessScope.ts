import type { ExecutionProcess } from 'shared/types';

export const belongsToSession = (
  process: ExecutionProcess,
  sessionId: string | undefined
): boolean => !!sessionId && process.session_id === sessionId;

// Optimistic overlay op on the streamed process list, keyed by process id.
export type OptimisticOp =
  | { kind: 'add'; process: ExecutionProcess }
  | { kind: 'patch'; changes: Partial<ExecutionProcess> }
  | { kind: 'remove' };

/**
 * Merge the optimistic overlay onto the streamed process list: apply
 * removes/patches to streamed rows, then append `add` ops not yet streamed —
 * but only when the added process belongs to the currently selected session.
 * That session guard is what stops a follow-up that resolves after the user
 * switched conversations (A → B) from briefly showing session A's response
 * under session B. Returns the streamed list by reference when there is no
 * overlay, so identity-based memoization downstream stays intact.
 */
export function mergeOptimisticProcesses(
  executionProcesses: ExecutionProcess[],
  optimistic: Record<string, OptimisticOp>,
  sessionId: string | undefined
): ExecutionProcess[] {
  if (Object.keys(optimistic).length === 0) return executionProcesses;
  const streamedIds = new Set(executionProcesses.map((p) => p.id));
  const result: ExecutionProcess[] = [];
  for (const p of executionProcesses) {
    const op = optimistic[p.id];
    if (op?.kind === 'remove') continue;
    result.push(op?.kind === 'patch' ? { ...p, ...op.changes } : p);
  }
  for (const [id, op] of Object.entries(optimistic)) {
    if (
      op.kind === 'add' &&
      !streamedIds.has(id) &&
      belongsToSession(op.process, sessionId)
    ) {
      result.push(op.process);
    }
  }
  return result.sort(
    (a, b) =>
      new Date(a.created_at as unknown as string).getTime() -
      new Date(b.created_at as unknown as string).getTime()
  );
}
