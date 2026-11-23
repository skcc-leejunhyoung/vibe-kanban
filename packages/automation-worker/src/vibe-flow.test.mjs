import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { eventMatchesRoutine } from './routines.mjs';
import {
  ARCHIVED_REASON,
  VIBE_FLOW_DEFAULTS,
  decideVibe,
  finishFor,
  forArchivedWorkspace,
  needsFinish,
  stalledReason,
  vibeFlowSettings,
  vibeStepRequest,
} from './vibe-flow.mjs';

const limits = VIBE_FLOW_DEFAULTS.limits;

// A finished turn of the run's review session, as the host reports it.
function turn(input = {}) {
  return {
    id: 'event-1',
    kind: 'vibe.turn_ended',
    phase: 'review',
    generation: 2,
    role: 'review',
    result: 'none',
    status: 'completed',
    run_reason: 'codingagent',
    coding_turns: 0,
    review_turns: 0,
    merge_retries: 0,
    last_error: null,
    pr_requested: false,
    ...input,
  };
}

function merged(input = {}) {
  return {
    id: 'event-2',
    kind: 'vibe.merge_result',
    phase: 'done',
    generation: 2,
    outcome: 'merged',
    merge_retries: 0,
    pr_requested: false,
    ...input,
  };
}

const decide = (event, finish = 'merge') => decideVibe(event, { finish, limits });

// ---- the review's verdict --------------------------------------------------

test('an approving review merges, whether the agent or its cleanup ended the turn', () => {
  for (const run_reason of ['codingagent', 'cleanupscript'])
    assert.deepEqual(decide(turn({ result: 'approve', run_reason })), { action: 'merge' });
});

test('turns that did not run to their end, or of another session, decide nothing', () => {
  for (const status of ['failed', 'killed'])
    assert.equal(decide(turn({ result: 'approve', status })), null);
  for (const run_reason of ['devserver', 'archivescript', 'setupscript'])
    assert.equal(decide(turn({ result: 'approve', run_reason })), null);
  // A late completion of the original coding session during review.
  assert.equal(decide(turn({ result: 'approve', role: 'coding' })), null);
});

test('a blocked run merges again only when its review re-approves a failed merge', () => {
  const reapprove = turn({ phase: 'blocked', result: 'approve', last_error: 'repo: merge conflict', merge_retries: 3 });
  for (const run_reason of ['codingagent', 'cleanupscript'])
    assert.deepEqual(decide({ ...reapprove, run_reason }), { action: 'merge' });
  for (const other of [
    { last_error: null },
    { role: 'coding' },
    { result: 'continue' },
    { status: 'failed' },
  ])
    assert.equal(decide({ ...reapprove, ...other }), null, JSON.stringify(other));
});

test('a review turn on a failed merge merges again, the retry budget bounding it', () => {
  assert.deepEqual(decide(turn({ phase: 'merging', merge_retries: 1 })), { action: 'merge' });
  assert.deepEqual(decide(turn({ phase: 'merging', result: 'done' })), { action: 'merge' });
  // An agent no longer stops the run: a stray "blocked" merges again too.
  assert.deepEqual(decide(turn({ phase: 'merging', result: 'blocked', merge_retries: 1 })), { action: 'merge' });
  assert.equal(decide(turn({ phase: 'merging', role: 'coding' })), null);
});

// The push / PR follow-up is a step of its own: the agent drafting the PR
// text ends turns while it runs, and none of them may act.
test('turns after the merge decide nothing', () => {
  for (const phase of ['done', 'pushing', 'creating_pr'])
    for (const result of ['none', 'done', 'approve', 'continue', 'blocked'])
      for (const role of ['coding', 'review'])
        assert.equal(decide(turn({ phase, result, role, last_error: 'x' })), null);
});

// ---- coding turns ----------------------------------------------------------

const coding = (input = {}) => turn({ phase: 'coding', role: 'coding', generation: 0, ...input });

// "기획에 맞게 빠짐없이 구현했는지 꼼꼼하게 확인해줘" comes between a coding
// `done` and the review; only a `done` answering it goes on to review.
test('finished coding is checked against the plan first, even through its cleanup', () => {
  for (const result of ['done', 'approve'])
    assert.deepEqual(decide(coding({ result })), { action: 'send-prompt', kind: 'plan_review' });
  assert.deepEqual(decide(coding({ result: 'done', run_reason: 'cleanupscript' })), {
    action: 'send-prompt',
    kind: 'plan_review',
  });
});

test('a done that answers the plan check starts the review; gaps it found go on coding', () => {
  const checked = (input) => coding({ prompt: 'plan_review', ...input });
  assert.deepEqual(decide(checked({ result: 'done' })), { action: 'start-review' });
  assert.deepEqual(decide(checked({ result: 'done', run_reason: 'cleanupscript' })), {
    action: 'start-review',
  });
  // Gaps found and still being fixed: coding goes on, and its next `done`
  // is checked again.
  assert.deepEqual(decide(checked({ result: 'continue' })), { action: 'send-prompt', kind: 'continue' });
  assert.deepEqual(decide(coding({ prompt: 'continue', result: 'done' })), {
    action: 'send-prompt',
    kind: 'plan_review',
  });
});

test('the plan check spends a coding turn, never blocks a finished run, and can be off', () => {
  // The budget is spent: straight to review rather than a check it cannot afford.
  assert.deepEqual(decide(coding({ result: 'done', coding_turns: 10 })), { action: 'start-review' });
  assert.deepEqual(decideVibe(coding({ result: 'done' }), { limits, planReview: false }), {
    action: 'start-review',
  });
  assert.equal(vibeFlowSettings({}).planReview, true);
  assert.equal(vibeFlowSettings({ planReview: false }).planReview, false);
});

test('coding goes on while work remains, within the coding budget', () => {
  assert.deepEqual(decide(coding({ result: 'continue', coding_turns: 2 })), {
    action: 'send-prompt',
    kind: 'continue',
  });
  // No sentinel at all: keep going.
  assert.deepEqual(decide(coding({ result: 'none', coding_turns: 0 })), {
    action: 'send-prompt',
    kind: 'continue',
  });
  const spent = decide(coding({ result: 'continue', coding_turns: 10 }));
  assert.equal(spent.action, 'block');
  assert.match(spent.reason, /limit of 10 turns/);
});

// Agents are no longer offered "blocked" (decisions go to the Drawer); one
// still saying it is taken as not finished, within the same budgets.
test('an agent that says blocked does not stop the run', () => {
  assert.deepEqual(decide(coding({ result: 'blocked' })), { action: 'send-prompt', kind: 'continue' });
  assert.deepEqual(decide(turn({ result: 'blocked' })), { action: 'send-prompt', kind: 'review_followup' });
  assert.equal(decide(coding({ result: 'blocked', coding_turns: 10 })).action, 'block');
  assert.equal(decide(turn({ result: 'blocked', review_turns: 5 })).action, 'block');
});

test('a failed or killed coding turn, a failed setup and other scripts decide nothing', () => {
  for (const status of ['failed', 'killed'])
    assert.equal(decide(coding({ result: 'done', status })), null);
  assert.equal(decide(coding({ run_reason: 'setupscript', status: 'failed' })), null);
  for (const run_reason of ['devserver', 'archivescript'])
    assert.equal(decide(coding({ result: 'done', run_reason })), null);
});

test('blocked and finished runs never act on a coding session', () => {
  for (const phase of ['blocked', 'done'])
    assert.equal(decide(coding({ phase, result: 'done' })), null);
});

// ---- review turns ----------------------------------------------------------

test('a review that did not approve is asked again, within the review budget', () => {
  for (const result of ['none', 'continue', 'done'])
    assert.deepEqual(decide(turn({ result, review_turns: 1 })), {
      action: 'send-prompt',
      kind: 'review_followup',
    });
  const spent = decide(turn({ result: 'none', review_turns: 5 }));
  assert.equal(spent.action, 'block');
  assert.match(spent.reason, /limit of 5 turns/);
});

// ---- failed cleanup --------------------------------------------------------

const cleanup = (input = {}) => ({
  id: 'cleanup-1',
  kind: 'vibe.cleanup_failed',
  phase: 'coding',
  generation: 0,
  role: 'coding',
  status: 'failed',
  run_reason: 'cleanupscript',
  coding_turns: 0,
  review_turns: 0,
  merge_retries: 0,
  ...input,
});

test('a failed cleanup goes back to its session with the log, on its phase budget', () => {
  assert.deepEqual(decide(cleanup()), { action: 'send-prompt', kind: 'cleanup_fix' });
  for (const phase of ['review', 'merging'])
    assert.deepEqual(decide(cleanup({ phase, role: 'review' })), {
      action: 'send-prompt',
      kind: 'cleanup_fix',
    });
  // Another session's cleanup during review is not the run's.
  assert.equal(decide(cleanup({ phase: 'review', role: 'coding' })), null);
  assert.match(decide(cleanup({ coding_turns: 10 })).reason, /limit of 10 turns/);
  assert.match(decide(cleanup({ phase: 'review', role: 'review', review_turns: 5 })).reason, /limit of 5 turns/);
  for (const phase of ['blocked', 'done', 'pushing', 'creating_pr'])
    assert.equal(decide(cleanup({ phase, role: 'review' })), null);
});

test('turn limits come from the rule settings', () => {
  const tight = { ...limits, codingTurns: 2, reviewTurns: 1 };
  assert.equal(decideVibe(coding({ result: 'continue', coding_turns: 2 }), { limits: tight }).action, 'block');
  assert.equal(decideVibe(turn({ result: 'none', review_turns: 1 }), { limits: tight }).action, 'block');
  assert.equal(decideVibe(cleanup({ coding_turns: 2 }), { limits: tight }).action, 'block');
});

// ---- the merge's outcome ---------------------------------------------------

test('a landed merge finishes at the merge, or goes on to the PR where the project ends there', () => {
  for (const outcome of ['merged', 'skipped_open_pr']) {
    assert.deepEqual(decide(merged({ outcome }), 'merge'), { action: 'finish' });
    assert.deepEqual(decide(merged({ outcome }), 'pr'), { action: 'publish-pr' });
    // "Review and Create PR from AI" asked for the PR on this run.
    assert.deepEqual(decide(merged({ outcome, pr_requested: true }), 'merge'), {
      action: 'publish-pr',
    });
  }
  assert.ok(needsFinish(merged()));
  assert.ok(!needsFinish(merged({ pr_requested: true })));
  assert.ok(!needsFinish(merged({ outcome: 'conflict' })));
  assert.ok(!needsFinish(turn({ result: 'approve' })));
});

test('a conflict goes to the review session until the retry budget is spent', () => {
  const conflict = (merge_retries) =>
    decide(merged({ phase: 'merging', outcome: 'conflict', error: 'repo: merge conflict', merge_retries }));
  assert.deepEqual(conflict(0), { action: 'send-prompt', kind: 'resolve_conflict' });
  assert.deepEqual(conflict(2), { action: 'send-prompt', kind: 'resolve_conflict' });
  // A fourth attempt exceeds the three retries.
  const exceeded = conflict(3);
  assert.equal(exceeded.action, 'block');
  assert.match(exceeded.reason, /3 retries: repo: merge conflict/);
});

// Another checkout's edits or a git lock are waited out by the host; only
// once the wait is over does the failure reach the review session, on the
// same budget as conflicts.
test('a merge whose wait ran out is handed to the review session within the budget', () => {
  const expired = (merge_retries) =>
    decide(merged({ phase: 'merging', outcome: 'wait_expired', error: 'dirty', merge_retries, waited_minutes: 30 }));
  assert.deepEqual(expired(0), { action: 'send-prompt', kind: 'hand_merge_failure' });
  assert.equal(expired(3).action, 'block');
});

test('any other merge failure blocks at once', () => {
  const failed = decide(merged({ phase: 'merging', outcome: 'failed', error: 'nothing merged and no open PR' }));
  assert.equal(failed.action, 'block');
  assert.match(failed.reason, /nothing merged/);
});

test('a smaller retry budget from the rule settings applies without a host change', () => {
  const event = merged({ phase: 'merging', outcome: 'conflict', merge_retries: 1 });
  assert.equal(decideVibe(event, { limits: { ...limits, mergeRetries: 1 } }).action, 'block');
  assert.equal(decideVibe(event, { limits }).action, 'send-prompt');
});

// ---- the PR's outcome ------------------------------------------------------

test('an opened or already open PR finishes the run; a failed one blocks with its reason', () => {
  const pr = (input) => ({ id: 'e', kind: 'vibe.pr_result', phase: 'done', generation: 2, ...input });
  assert.deepEqual(decide(pr({ outcome: 'opened', pr_url: 'https://example.invalid/pull/1' })), { action: 'finish' });
  assert.deepEqual(decide(pr({ outcome: 'already_open' })), { action: 'finish' });
  assert.deepEqual(decide(pr({ phase: 'blocked', outcome: 'failed', failed_phase: 'pushing', error: 'diverged' })), {
    action: 'block',
    reason: 'diverged',
  });
});

// ---- a step the host keeps failing ------------------------------------------

// The old watcher blocked a run whose next step could not start; the event
// of a failed step comes back counted, and the run blocks at the limit.
test('a step that keeps failing on the host blocks the run with its error', () => {
  const failing = coding({ result: 'continue', failed_attempts: 2, failed_step: 'send-prompt', failure: 'no executor profile' });
  assert.deepEqual(decide(failing), { action: 'send-prompt', kind: 'continue' });
  const spent = decide({ ...failing, failed_attempts: 3 });
  assert.equal(spent.action, 'block');
  assert.match(spent.reason, /send-prompt step failed 3 times: no executor profile/);
  assert.equal(decideVibe({ ...failing, failed_attempts: 1 }, { limits: { ...limits, stepFailures: 1 } }).action, 'block');
  assert.equal(vibeFlowSettings({ limits: { stepFailures: 0 } }).limits.stepFailures, 1);
});

test('an archived workspace takes no step that starts work in it', () => {
  for (const action of ['start-review', 'send-prompt', 'merge', 'publish-pr'])
    assert.deepEqual(forArchivedWorkspace({ action, kind: 'continue' }), { action: 'block', reason: ARCHIVED_REASON });
  for (const action of ['finish', 'dismiss'])
    assert.deepEqual(forArchivedWorkspace({ action }), { action });
  assert.deepEqual(forArchivedWorkspace({ action: 'block', reason: 'x' }), { action: 'block', reason: 'x' });
  assert.equal(forArchivedWorkspace(null), null);
});

// ---- settings, staleness, requests -----------------------------------------

test('settings fill in defaults and map projects to their finish', () => {
  const settings = vibeFlowSettings({
    projects: { 'project-pr': { finish: 'pr' }, 'project-odd': { finish: 'deploy' } },
    limits: { reviewTurns: 2, codingTurns: -1 },
  });
  assert.equal(settings.defaultFinish, 'merge');
  assert.equal(finishFor(settings, 'project-pr'), 'pr');
  assert.equal(finishFor(settings, 'project-odd'), 'merge');
  assert.equal(finishFor(settings, 'project-unlisted'), 'merge');
  assert.equal(finishFor(settings, null), 'merge');
  assert.deepEqual(settings.limits, { codingTurns: 10, reviewTurns: 2, mergeRetries: 3, stepFailures: 3 });
  assert.equal(vibeFlowSettings({ defaultFinish: 'pr' }).defaultFinish, 'pr');
});

test('a run is stalled only when nothing ran or was scheduled for the stale window', () => {
  const now = Date.parse('2026-06-19T12:00:00Z');
  const settings = { staleMinutes: 15 };
  const run = (input) => ({ phase: 'review', running: false, archived: false, updated_at: '2026-06-19T11:30:00Z', ...input });
  assert.match(stalledReason(run({}), settings, now), /No progress for 15 minutes/);
  // Exactly at the threshold.
  assert.ok(stalledReason(run({ updated_at: '2026-06-19T11:45:00Z' }), settings, now));
  assert.equal(stalledReason(run({ updated_at: '2026-06-19T11:55:00Z' }), settings, now), null);
  // A long turn that finished a minute ago.
  assert.equal(stalledReason(run({ updated_at: '2026-06-19T10:00:00Z', last_activity_at: '2026-06-19T11:59:00Z' }), settings, now), null);
  assert.equal(stalledReason(run({ running: true, updated_at: '2026-06-19T10:00:00Z' }), settings, now), null);
  // An archived workspace's run is blocked at once, not after the window.
  assert.equal(stalledReason(run({ archived: true, updated_at: '2026-06-19T11:59:00Z' }), settings, now), ARCHIVED_REASON);
  assert.equal(stalledReason(run({ archived: true, phase: 'done' }), settings, now), null);
  // A merge waiting for its next try is not stalled until the try is overdue.
  assert.equal(stalledReason(run({ phase: 'merging', merge_retry_at: '2026-06-19T12:05:00Z' }), settings, now), null);
  assert.ok(stalledReason(run({ phase: 'merging', updated_at: '2026-06-19T11:00:00Z', merge_retry_at: '2026-06-19T11:40:00Z' }), settings, now));
  // Finished, blocked, or in a push / PR step the host watches itself.
  for (const phase of ['done', 'blocked', 'pushing', 'creating_pr'])
    assert.equal(stalledReason(run({ phase, updated_at: '2026-06-19T09:00:00Z' }), settings, now), null);
});

test('a step names the state it was decided on and one key per event and step', () => {
  const event = merged({ phase: 'merging', outcome: 'conflict', id: 'abc' });
  const request = vibeStepRequest('ws-1', event, { action: 'send-prompt', kind: 'resolve_conflict' });
  assert.equal(request.path, '/api/automation-actions/vibe/ws-1/send-prompt');
  assert.deepEqual(request.body, {
    expected_generation: 2,
    expected_phase: 'merging',
    pending_id: 'abc',
    kind: 'resolve_conflict',
  });
  assert.equal(request.key, 'vibe:ws-1:2:send-prompt:abc');
  assert.equal(vibeStepRequest('ws-1', event, { action: 'merge' }).key, 'vibe:ws-1:2:merge:abc');
  const stalled = vibeStepRequest('ws-1', { kind: 'vibe.stalled', phase: 'review', generation: 4 }, { action: 'block', reason: 'stalled' });
  assert.equal(stalled.body.pending_id, null);
  assert.equal(stalled.key, 'vibe:ws-1:4:block:none');
  const since = vibeStepRequest('ws-1', { kind: 'vibe.stalled', phase: 'merging', generation: 4, updated_at: '2026-06-19T11:00:00Z' }, { action: 'block', reason: 'stalled' });
  assert.equal(since.body.pending_id, null);
  assert.equal(since.key, 'vibe:ws-1:4:block:2026-06-19T11:00:00Z');
});

// The Autopilot's catch-all routine must not wake for every vibe turn: the
// flow's own events reach a routine only when its trigger names them.
test('a routine hears the vibe flow events only when it names them', () => {
  const routine = (kinds) => ({ id: 'r', enabled: true, trigger: { type: 'vk_event', kinds } });
  const event = { type: 'vk_event', kind: 'vibe.turn_ended' };
  assert.equal(eventMatchesRoutine(routine(undefined), event), false);
  assert.equal(eventMatchesRoutine(routine([]), event), false);
  assert.equal(eventMatchesRoutine(routine(['vibe.']), event), true);
  assert.equal(eventMatchesRoutine(routine(['vibe.phase']), event), false);
  // Everything else still reaches a catch-all routine, `vibe.phase` included.
  assert.equal(eventMatchesRoutine(routine(undefined), { ...event, kind: 'vibe.phase' }), true);
});

// ---- the worker against a host ---------------------------------------------

// The production functions, run against a host double that keeps runs as the
// server does: a step must name the run's generation, phase and pending event,
// and an idempotency key answers a repeat with the first result.
const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
function productionFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing production function ${name}`);
  return source.slice(match.index, source.indexOf('\n}\n', match.index) + 2);
}
const flowSource = await readFile(new URL('./vibe-flow.mjs', import.meta.url), 'utf8');

function harness({ projects = {}, runs = {} } = {}) {
  const posts = [];
  const receipts = new Map();
  const logs = [];
  const host = {
    runs,
    // What the host does when a step is taken (as the server would move the run).
    effects: {},
  };
  const vibeApi = async (connector, method, path, body, baseUrl, meta) => {
    if (!baseUrl) {
      if (path === '/v1/hosts')
        return { hosts: [{ id: 'cloud-host', machine_id: 'machine-1', access_role: 'owner' }] };
      const issue = /^\/v1\/issues\/(.+)$/.exec(path);
      if (issue) {
        const projectId = projects[issue[1]];
        if (!projectId) throw Object.assign(new Error('404'), { status: 404 });
        return { data: { id: issue[1], project_id: projectId } };
      }
      throw new Error(`unexpected cloud call ${path}`);
    }
    assert.equal(baseUrl, 'http://host.invalid');
    if (method === 'GET' && path === '/api/automation-actions/vibe/runs')
      return { runs: Object.values(host.runs).map((run) => structuredClone(run)) };
    const step = /^\/api\/automation-actions\/vibe\/([^/]+)\/([^/]+)$/.exec(path);
    assert.ok(step, path);
    const [, workspaceId, action] = step;
    if (meta?.idempotencyKey && receipts.has(meta.idempotencyKey)) return receipts.get(meta.idempotencyKey);
    if (host.fail?.[action])
      throw Object.assign(new Error(`Vibe POST failed: 500 ${host.fail[action]}`), { status: 500 });
    const run = host.runs[workspaceId];
    if (
      !run ||
      run.generation !== body.expected_generation ||
      run.phase !== body.expected_phase ||
      (run.pending?.id ?? null) !== body.pending_id
    )
      throw Object.assign(new Error('Vibe POST failed: 409 the run moved on'), { status: 409 });
    posts.push({ workspaceId, action, body, key: meta?.idempotencyKey });
    run.pending = null;
    host.effects[action]?.(run, body);
    const response = { ok: true, action };
    if (meta?.idempotencyKey) receipts.set(meta.idempotencyKey, response);
    return response;
  };
  const context = {
    state: {
      connectors: [
        {
          id: 'vibe-default',
          type: 'vibe_kanban',
          enabled: true,
          config: { hostBridges: { 'machine-1': { baseUrl: 'http://host.invalid' } } },
        },
      ],
      rules: [
        {
          id: 'vibe-flow',
          kind: 'vibe_flow',
          enabled: true,
          config: { projects: { 'project-c': { finish: 'pr' } } },
        },
      ],
    },
    vibeApi,
    log: async (level, message, meta) => logs.push({ level, message, ...meta }),
    errorMessage: (error) => String(error?.message || error),
    Map,
    Date,
    Object,
    Math,
    Number,
    String,
    AbortSignal,
    JSON,
    encodeURIComponent,
    structuredClone,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      flowSource.replace(/^export /gm, ''),
      'const vibeFlowTimeout = () => AbortSignal.timeout(60000);',
      'const vibeFlowHostCatalogs = new Map();',
      'const vibeFlowProjects = new Map();',
      'const vibeFlowReconciledAt = new Map();',
      'const vibeFlowBridgeErrors = new Map();',
      'let vibeFlowReconciling = false;',
      ...[
        'vibeFlowBridge',
        'vibeFlowProject',
        'vibeFlowConnector',
        'driveVibeRun',
        'handleVibeFlowEvent',
        'reconcileVibeFlow',
      ].map(productionFunction),
      'globalThis.handle = handleVibeFlowEvent; globalThis.reconcile = reconcileVibeFlow;',
    ].join('\n'),
    context
  );
  const rule = context.state.rules[0];
  return {
    host,
    posts,
    logs,
    // An event as the `vibe_events` connector hands it to the rules.
    deliver: (workspaceId, data, hostId = 'cloud-host') =>
      context.handle(rule, { source: 'vibe', kind: data.kind, hostId, workspaceId, data }),
    reconcile: (now) => context.reconcile(now),
  };
}

test('an approval merges, and the landed merge finishes or opens the PR by the issue project', async () => {
  for (const [project, last] of [
    ['project-plain', 'finish'],
    ['project-c', 'publish-pr'],
  ]) {
    const approve = turn({ id: 'approve-1', task_id: 'task-1', result: 'approve' });
    const world = harness({
      projects: { 'task-1': project },
      runs: { ws: { workspace_id: 'ws', phase: 'review', generation: 2, pending: approve } },
    });
    world.host.effects.merge = (run) => {
      run.phase = 'done';
      run.pending = merged({ id: 'merged-1', task_id: 'task-1' });
    };
    await world.deliver('ws', approve);
    await world.deliver('ws', world.host.runs.ws.pending);
    assert.deepEqual(
      world.posts.map((post) => post.action),
      ['merge', last]
    );
    assert.deepEqual(JSON.parse(JSON.stringify(world.posts[1].body)), {
      expected_generation: 2,
      expected_phase: 'done',
      pending_id: 'merged-1',
    });
  }
});

test('coding turns go on, then start the review in the session that reported done', async () => {
  const world = harness({
    runs: {
      ws: {
        workspace_id: 'ws',
        phase: 'coding',
        generation: 0,
        pending: coding({ id: 'turn-1', result: 'continue', session_id: 'coding-session' }),
      },
    },
  });
  // The host reports each prompted turn with the prompt that started it.
  const next = [
    coding({ id: 'turn-2', result: 'done', coding_turns: 1, prompt: 'continue', session_id: 'coding-session' }),
    coding({ id: 'turn-3', result: 'done', coding_turns: 2, prompt: 'plan_review', session_id: 'coding-session' }),
  ];
  world.host.effects['send-prompt'] = (run) => {
    run.pending = next.shift();
  };
  world.host.effects['start-review'] = (run) => {
    run.phase = 'review';
    run.generation = 1;
  };
  for (let turns = 0; turns < 3; turns++) await world.deliver('ws', world.host.runs.ws.pending);
  assert.deepEqual(
    world.posts.map(({ action, body }) => [action, body.kind ?? null, body.pending_id]),
    [
      ['send-prompt', 'continue', 'turn-1'],
      ['send-prompt', 'plan_review', 'turn-2'],
      ['start-review', null, 'turn-3'],
    ]
  );
  assert.equal(world.host.runs.ws.phase, 'review');
});

test('the same event twice takes its step once; an old one is refused and let go', async () => {
  const approve = turn({ id: 'approve-1', result: 'approve' });
  const world = harness({ runs: { ws: { workspace_id: 'ws', phase: 'review', generation: 2, pending: approve } } });
  world.host.effects.merge = (run) => {
    run.phase = 'merging';
  };
  await world.deliver('ws', approve);
  await world.deliver('ws', approve);
  assert.equal(world.posts.length, 1);
  // An event from before the run moved on is refused by the host: no error.
  await world.deliver('ws', turn({ id: 'stale', result: 'approve', generation: 1 }));
  assert.equal(world.posts.length, 1);
  assert.ok(world.logs.some((entry) => entry.message === 'vibe flow step refused'));
});

test('reconciliation decides on events that never arrived and blocks runs that stopped', async () => {
  const now = Date.parse('2026-06-19T12:00:00Z');
  const world = harness({
    runs: {
      // Approved while the worker was down: its event was never delivered.
      approved: { workspace_id: 'approved', phase: 'review', generation: 1, pending: turn({ id: 'lost', result: 'approve', generation: 1 }), running: false, updated_at: '2026-06-19T11:00:00Z' },
      // A turn is running there: left for its own event.
      busy: { workspace_id: 'busy', phase: 'review', generation: 1, pending: turn({ id: 'busy-1', result: 'approve', generation: 1 }), running: true },
      // Nothing to answer and no progress for half an hour.
      stalled: { workspace_id: 'stalled', phase: 'review', generation: 3, pending: null, running: false, updated_at: '2026-06-19T11:30:00Z' },
      // A failed turn nobody acts on: let go, then blocked as stalled.
      killed: { workspace_id: 'killed', phase: 'review', generation: 1, pending: turn({ id: 'killed-1', status: 'killed', generation: 1 }), running: false, updated_at: '2026-06-19T11:00:00Z' },
      fresh: { workspace_id: 'fresh', phase: 'review', generation: 1, pending: null, running: false, updated_at: '2026-06-19T11:58:00Z' },
      // An event of a generation the run has left: let go, never acted on.
      outdated: { workspace_id: 'outdated', phase: 'merging', generation: 3, pending: turn({ id: 'old', result: 'approve', generation: 2 }), running: false, updated_at: '2026-06-19T11:59:00Z' },
    },
  });
  await world.reconcile(now);
  assert.deepEqual(
    world.posts.map(({ workspaceId, action, body }) => [workspaceId, action, body.pending_id]),
    [
      ['approved', 'merge', 'lost'],
      ['stalled', 'block', null],
      ['killed', 'dismiss', 'killed-1'],
      ['killed', 'block', null],
      ['outdated', 'dismiss', 'old'],
    ]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(world.posts[4].body)),
    { expected_generation: 3, expected_phase: 'merging', pending_id: 'old' }
  );
  assert.match(world.posts[1].body.reason, /No progress for 15 minutes/);
  // Not again before `reconcileSeconds` has passed.
  await world.reconcile(now + 60000);
  assert.equal(world.posts.length, 5);
});

// Blocked, approved again after its failed merge (same generation) and
// stalled once more: the second block is a new step, not the first one's
// stored answer.
test('a run that stalls again in the same generation is blocked again', async () => {
  const now = Date.parse('2026-06-19T12:00:00Z');
  const stalled = (updated_at) => ({ workspace_id: 'ws', phase: 'merging', generation: 3, pending: null, running: false, last_error: 'repo: conflict', updated_at });
  const world = harness({ runs: { ws: stalled('2026-06-19T11:00:00Z') } });
  world.host.effects.block = (run) => { run.phase = 'blocked'; };
  await world.reconcile(now);
  world.host.runs.ws = stalled('2026-06-19T12:10:00Z');
  await world.reconcile(now + 60 * 60000);
  assert.deepEqual(world.posts.map(({ action }) => action), ['block', 'block']);
  assert.notEqual(world.posts[0].key, world.posts[1].key);
  assert.equal(world.host.runs.ws.phase, 'blocked');
});

// A step that could not be asked for stays pending on the run for the
// reconciliation: no error reaches the retry queue (whose exhaustion would
// wake the Autopilot) and nothing waits on it.
test('an unbridged host, or a host that fails the step, leaves the event to reconciliation', async () => {
  const approve = turn({ id: 'approve-1', result: 'approve' });
  const world = harness({ runs: { ws: { workspace_id: 'ws', phase: 'review', generation: 2, pending: approve } } });
  assert.equal(await world.deliver('ws', approve, 'unbridged-host'), null);
  world.host.fail = { merge: 'pool timed out' };
  assert.equal(await world.deliver('ws', approve), null);
  assert.equal(world.posts.length, 0);
  const warnings = world.logs.filter((entry) => entry.message === 'vibe flow: event left to reconciliation');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].error, /no configured bridge/);
  assert.match(warnings[1].error, /pool timed out/);
});

test('a run whose issue the cloud does not know finishes at the default', async () => {
  const world = harness({ projects: {}, runs: { ws: { workspace_id: 'ws', phase: 'done', generation: 2, pending: merged({ task_id: 'unknown-task' }) } } });
  await world.deliver('ws', world.host.runs.ws.pending);
  assert.deepEqual(world.posts.map((post) => post.action), ['finish']);
});

test('reconciliation blocks the runs of archived workspaces instead of starting work there', async () => {
  const now = Date.parse('2026-06-19T12:00:00Z');
  const world = harness({
    projects: { 'task-done': 'project-plain' },
    runs: {
      approved: { workspace_id: 'approved', phase: 'review', generation: 1, archived: true, running: false, pending: turn({ id: 'a1', result: 'approve', generation: 1 }), updated_at: '2026-06-19T11:59:00Z' },
      coding: { workspace_id: 'coding', phase: 'coding', generation: 0, archived: true, running: false, pending: null, updated_at: '2026-06-19T11:59:00Z' },
      // The merge landed before it was archived: finishing starts no work.
      landed: { workspace_id: 'landed', phase: 'done', generation: 1, archived: true, running: false, pending: merged({ id: 'm1', generation: 1, task_id: 'task-done' }) },
    },
  });
  await world.reconcile(now);
  assert.deepEqual(
    world.posts.map(({ workspaceId, action, body }) => [workspaceId, action, body.pending_id, body.reason ?? null]),
    [
      ['approved', 'block', 'a1', ARCHIVED_REASON],
      ['coding', 'block', null, ARCHIVED_REASON],
      ['landed', 'finish', 'm1', null],
    ]
  );
});
