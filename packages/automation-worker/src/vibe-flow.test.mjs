import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { eventMatchesRoutine } from './routines.mjs';
import {
  VIBE_FLOW_DEFAULTS,
  decideVibe,
  finishFor,
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

test('a review turn on a failed merge merges again unless it gave up', () => {
  assert.deepEqual(decide(turn({ phase: 'merging', merge_retries: 1 })), { action: 'merge' });
  assert.deepEqual(decide(turn({ phase: 'merging', result: 'done' })), { action: 'merge' });
  // The agent gave up on the conflict: block now rather than burning the
  // remaining merge retries on it.
  assert.equal(decide(turn({ phase: 'merging', result: 'blocked', merge_retries: 1 })).action, 'block');
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
  assert.deepEqual(settings.limits, { codingTurns: 10, reviewTurns: 2, mergeRetries: 3 });
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
  assert.equal(stalledReason(run({ archived: true }), settings, now), null);
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
    deliver: (workspaceId, data) =>
      context.handle(rule, { source: 'vibe', kind: data.kind, hostId: 'cloud-host', workspaceId, data }),
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
