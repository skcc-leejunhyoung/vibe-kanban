import {
  type BaseCodingAgent,
  type ExecutionProcess,
  ExecutionProcessStatus,
  type ExecutorConfig,
} from 'shared/types';

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

/**
 * Drop overlay ops the stream has caught up with. An `add` whose row has
 * arrived is normally done — unless a stop was folded into it (status no
 * longer running) while the streamed row still says running: then it becomes
 * a `patch` so the optimistic kill stays visible until the server reports the
 * terminal status, exactly like a stop on an already-streamed row.
 */
export function reconcileOptimisticOps(
  current: Record<string, OptimisticOp>,
  streamedById: Record<string, ExecutionProcess>
): Record<string, OptimisticOp> {
  const ids = Object.keys(current);
  if (ids.length === 0) return current;
  let changed = false;
  const next = { ...current };
  for (const id of ids) {
    const op = current[id];
    const streamed = streamedById[id];
    if (op.kind === 'add') {
      if (!streamed) continue;
      if (
        streamed.status === ExecutionProcessStatus.running &&
        op.process.status !== ExecutionProcessStatus.running
      ) {
        next[id] = { kind: 'patch', changes: { status: op.process.status } };
      } else {
        delete next[id];
      }
      changed = true;
    } else if (op.kind === 'remove') {
      if (!streamed || streamed.dropped) {
        delete next[id];
        changed = true;
      }
    } else if (streamed && streamed.status !== ExecutionProcessStatus.running) {
      delete next[id];
      changed = true;
    }
  }
  return changed ? next : current;
}

/**
 * On a session switch keep only `add` ops: they are session-guarded by
 * `mergeOptimisticProcesses`, so a pending send's placeholder (or its real
 * process) is still there when the user comes back, while patches/removes —
 * which would apply to any streamed row with the same id — are dropped.
 */
export function keepOptimisticAdds(
  current: Record<string, OptimisticOp>
): Record<string, OptimisticOp> {
  const next: Record<string, OptimisticOp> = {};
  for (const [id, op] of Object.entries(current)) {
    if (op.kind === 'add') next[id] = op;
  }
  return Object.keys(next).length === Object.keys(current).length
    ? current
    : next;
}

/**
 * The real process behind a pending send, if the stream delivered it before
 * the POST returned (the row is published on insert, the POST only after the
 * spawn): a coding-agent row for the session that wasn't there at send time
 * and carries the sent prompt. Matching on the prompt keeps a turn started by
 * another client in the meantime from being mistaken for ours.
 */
export function matchArrivedProcess(
  processes: ExecutionProcess[],
  pending: { sessionId: string; knownIds: Set<string>; prompt: string }
): ExecutionProcess | undefined {
  return processes.find((p) => {
    if (pending.knownIds.has(p.id) || isPendingProcessId(p.id)) return false;
    if (p.session_id !== pending.sessionId || p.run_reason !== 'codingagent')
      return false;
    const typ = p.executor_action.typ;
    if (typ.type === 'CodingAgentFollowUpRequest') {
      return typ.prompt.trim() === pending.prompt;
    }
    if (typ.type === 'CodingAgentInitialRequest') {
      // A handoff carries the user's text separately from its bootstrap prompt.
      return (typ.handoff_user_prompt ?? typ.prompt).trim() === pending.prompt;
    }
    return false;
  });
}

// Processes handed over before their session's provider is on screen (the
// workspace-create / quick-chat / new-session responses): consumed once by
// that provider so the first turn renders before the stream's first replay.
const seededProcesses = new Map<string, ExecutionProcess[]>();

export function seedOptimisticProcess(process: ExecutionProcess): void {
  const list = seededProcesses.get(process.session_id) ?? [];
  seededProcesses.set(process.session_id, [...list, process]);
}

export function takeSeededProcesses(
  sessionId: string | undefined
): ExecutionProcess[] {
  if (!sessionId) return [];
  const list = seededProcesses.get(sessionId) ?? [];
  seededProcesses.delete(sessionId);
  return list;
}

const PENDING_PROCESS_ID_PREFIX = 'pending-';

/** True for a placeholder from `createPendingProcess` (no server row behind it). */
export const isPendingProcessId = (id: string): boolean =>
  id.startsWith(PENDING_PROCESS_ID_PREFIX);

/**
 * Placeholder for a follow-up whose POST hasn't returned yet. Added to the
 * optimistic overlay it renders the user's turn (and the running indicator)
 * the moment send is pressed, so the composer can be cleared and reused for
 * queueing instead of locking until the server acknowledges. Never fetch or
 * stream it by id — guard with `isPendingProcessId`.
 */
export function createPendingProcess(
  sessionId: string,
  prompt: string,
  executorConfig: ExecutorConfig,
  /** Timeline ordering is by created_at, and the client clock can lag the
   * server's: never let the placeholder sort before an existing process
   * (pass the newest existing created_at, in epoch ms). */
  notBeforeMs = 0,
  /** A handoff turn: renders the "from → to" line and the user's text, like
   * the real process (whose own prompt is the bootstrap text). */
  options?: { handoffFrom?: BaseCodingAgent }
): ExecutionProcess {
  const now = new Date(Math.max(Date.now(), notBeforeMs + 1)).toISOString();
  return {
    id: `${PENDING_PROCESS_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId,
    run_reason: 'codingagent',
    executor_action: {
      typ: options?.handoffFrom
        ? {
            type: 'CodingAgentInitialRequest',
            prompt: '',
            executor_config: executorConfig,
            working_dir: null,
            handoff_from: options.handoffFrom,
            handoff_session_id: null,
            handoff_user_prompt: prompt,
          }
        : {
            type: 'CodingAgentFollowUpRequest',
            prompt,
            session_id: '',
            reset_to_message_id: null,
            executor_config: executorConfig,
            working_dir: null,
          },
      next_action: null,
    },
    status: ExecutionProcessStatus.running,
    exit_code: null,
    dropped: false,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
}
