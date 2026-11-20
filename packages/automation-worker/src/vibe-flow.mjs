// The vibe flow: what a vibe-tagged issue's run does next. Each host records
// its runs, reports what happened to them as `vibe.*` events, and takes the
// steps asked of it (`/api/automation-actions/vibe/...`); every decision —
// the next step, where a project's run ends, how long a run may try — is
// made here, from the event and the rule's settings.

export const VIBE_FLOW_KINDS = [
  'vibe.turn_ended',
  'vibe.cleanup_failed',
  'vibe.merge_result',
  'vibe.pr_result',
];

export const VIBE_FLOW_DEFAULTS = {
  connectorId: 'vibe-default',
  // `merge`: the run ends at its local merge. `pr`: it goes on to push the
  // merge target and open an AI-drafted draft PR.
  defaultFinish: 'merge',
  // Per cloud project id: { finish }.
  projects: {},
  limits: { codingTurns: 10, reviewTurns: 5, mergeRetries: 3 },
  // How often every host's runs are read again, for events that never came.
  reconcileSeconds: 180,
  // A run with no turn running and nothing to do for this long is blocked.
  staleMinutes: 15,
};

const finishValue = (value, fallback = 'merge') =>
  value === 'pr' || value === 'merge' ? value : fallback;

const count = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
};

export function vibeFlowSettings(config = {}) {
  const defaults = VIBE_FLOW_DEFAULTS;
  const defaultFinish = finishValue(config.defaultFinish, defaults.defaultFinish);
  const limits = config.limits || {};
  return {
    connectorId: String(config.connectorId || defaults.connectorId),
    defaultFinish,
    projects: Object.fromEntries(
      Object.entries(config.projects || {}).map(([projectId, project]) => [
        projectId,
        { finish: finishValue(project?.finish, defaultFinish) },
      ])
    ),
    limits: {
      codingTurns: count(limits.codingTurns, defaults.limits.codingTurns),
      reviewTurns: count(limits.reviewTurns, defaults.limits.reviewTurns),
      mergeRetries: count(limits.mergeRetries, defaults.limits.mergeRetries),
    },
    reconcileSeconds: Math.max(30, Number(config.reconcileSeconds) || defaults.reconcileSeconds),
    staleMinutes: Math.max(1, Number(config.staleMinutes) || defaults.staleMinutes),
  };
}

export function finishFor(settings, projectId) {
  return settings.projects[projectId]?.finish || settings.defaultFinish;
}

const LANDED = ['merged', 'skipped_open_pr'];

// The decision on `event` depends on the project's finish only for a merge
// that landed in a run nobody asked a PR of.
export function needsFinish(event) {
  return (
    event?.kind === 'vibe.merge_result' &&
    LANDED.includes(event.outcome) &&
    !event.pr_requested
  );
}

const block = (reason) => ({ action: 'block', reason });
const prompt = (kind) => ({ action: 'send-prompt', kind });

// What `event` (a run's pending `vibe.*` payload: its phase, generation and
// counters, plus what happened) calls for: `{ action, kind?, reason? }`, or
// `null` when nothing is to be done. `finish` is where the run's project ends
// (`merge` | `pr`); `limits` bound turns and merge retries.
export function decideVibe(event, { finish = 'merge', limits = VIBE_FLOW_DEFAULTS.limits } = {}) {
  switch (event?.kind) {
    case 'vibe.turn_ended':
      return decideTurn(event, limits);
    case 'vibe.cleanup_failed':
      return decideCleanupFailure(event, limits);
    case 'vibe.merge_result':
      return decideMerge(event, finish, limits);
    // Reconciliation found the run stopped with nothing left to answer.
    case 'vibe.stalled':
      return block(event.reason || 'The run stopped making progress.');
    case 'vibe.pr_result':
      if (event.outcome === 'opened' || event.outcome === 'already_open')
        return { action: 'finish' };
      if (event.outcome === 'failed')
        return block(event.error || 'The push or the pull request failed.');
      return null;
    default:
      return null;
  }
}

const AGENT_BLOCKED = 'The agent reported it cannot go on (VIBE_RESULT: blocked).';

// Within the coding / review turn budget, `action`; past it, blocked.
const withinCoding = (event, limits, action) =>
  Number(event.coding_turns || 0) < limits.codingTurns
    ? action
    : block(`Coding reached its limit of ${limits.codingTurns} turns.`);
const withinReview = (event, limits, action) =>
  Number(event.review_turns || 0) < limits.reviewTurns
    ? action
    : block(`Review reached its limit of ${limits.reviewTurns} turns.`);

function decideTurn(event, limits) {
  // Only a turn that ran to its end (the agent, or the cleanup chained after
  // it) moves the run; a failed, killed or setup-only turn waits for a person.
  const finished =
    event.status === 'completed' &&
    (event.run_reason === 'codingagent' || event.run_reason === 'cleanupscript');
  if (!finished) return null;
  if (event.phase === 'coding') {
    switch (event.result) {
      // The coding agent's verb is "done"; a stray "approve" asks for review too.
      case 'done':
      case 'approve':
        return { action: 'start-review' };
      case 'blocked':
        return block(AGENT_BLOCKED);
      default:
        return withinCoding(event, limits, prompt('continue'));
    }
  }
  // After coding only the review session's turns move the run; a late one of
  // the original coding session does not.
  if (event.role !== 'review') return null;
  switch (event.phase) {
    case 'review':
      if (event.result === 'approve') return { action: 'merge' };
      if (event.result === 'blocked') return block(AGENT_BLOCKED);
      return withinReview(event, limits, prompt('review_followup'));
    // The review session worked on a failed merge it was handed: merge again,
    // unless it gave up.
    case 'merging':
      if (event.result === 'blocked')
        return block('The review session could not resolve the merge failure (VIBE_RESULT: blocked).');
      return { action: 'merge' };
    // Approved after a failed merge (the review was asked to look again): a
    // new attempt with the full retry budget.
    case 'blocked':
      return event.last_error && event.result === 'approve' ? { action: 'merge' } : null;
    default:
      return null;
  }
}

// A failed cleanup script goes back to the session that ran it, with its log,
// on the budget of the run's phase.
function decideCleanupFailure(event, limits) {
  if (event.phase === 'coding') return withinCoding(event, limits, prompt('cleanup_fix'));
  if ((event.phase === 'review' || event.phase === 'merging') && event.role === 'review')
    return withinReview(event, limits, prompt('cleanup_fix'));
  return null;
}

function decideMerge(event, finish, limits) {
  if (LANDED.includes(event.outcome))
    return { action: finish === 'pr' || event.pr_requested ? 'publish-pr' : 'finish' };
  const error = event.error || 'unknown failure';
  // Conflicts and hand-offs after a long wait share the retry budget.
  const withinBudget = Number(event.merge_retries || 0) + 1 <= limits.mergeRetries;
  if (event.outcome === 'conflict')
    return withinBudget
      ? prompt('resolve_conflict')
      : block(`The merge still conflicts after ${limits.mergeRetries} retries: ${error}`);
  if (event.outcome === 'wait_expired')
    return withinBudget
      ? prompt('hand_merge_failure')
      : block(`The merge is still blocked after ${limits.mergeRetries} retries: ${error}`);
  if (event.outcome === 'failed') return block(`The merge failed: ${error}`);
  return null;
}

// A run in a working phase with nothing running and nothing left to answer
// for `staleMinutes` stopped moving (a restart, a step that could not
// start): blocked for a person. A merge waiting for its next scheduled try,
// and a push / PR step (the host watches its own), are not stalled.
export function stalledReason(run, { staleMinutes }, now = Date.now()) {
  if (!['coding', 'review', 'merging'].includes(run?.phase)) return null;
  if (run.running || run.archived) return null;
  // A scheduled merge retry is activity to come: stale only once overdue.
  const last = Math.max(
    ...[run.updated_at, run.last_activity_at, run.merge_retry_at].map(
      (at) => Date.parse(at || 0) || 0
    )
  );
  if (now - last < staleMinutes * 60000) return null;
  return `No progress for ${staleMinutes} minutes (the server may have restarted, or a step could not start).`;
}

// The request body and idempotency key for `decision` on `event`.
export function vibeStepRequest(workspaceId, event, decision) {
  const action = decision.action;
  const body = {
    expected_generation: Number(event.generation ?? 0),
    expected_phase: String(event.phase || ''),
    pending_id: event.id ?? null,
  };
  if (decision.kind) body.kind = decision.kind;
  if (decision.reason) body.reason = String(decision.reason).slice(0, 2000);
  return {
    path: `/api/automation-actions/vibe/${encodeURIComponent(workspaceId)}/${action}`,
    body,
    key: `vibe:${workspaceId}:${body.expected_generation}:${action}:${event.id || 'none'}`,
  };
}
