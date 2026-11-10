import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  isIndeterminateActionError,
  pruneAutomationState,
  recoverInterruptedAutomationState,
  routineRunTrigger,
  scheduleOccurrence,
  validateRoutineScope,
} from './routines.mjs';
import { carriesRetryExhausted, renderPromptTemplate } from './vibe-events.mjs';
import { createNotificationRouting } from './notification-routing.mjs';

const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
const functions = [
  'runDueRoutines',
  'runRoutine',
  'executeRoutineAction',
  'removeRoutine',
  'completeRoutineRun',
  'processRetryQueue',
  'removeRetryItem',
  'routineConditionMatches',
  'runRule',
  'createRuleContext',
]
  .map((name) => {
    const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(
      source
    );
    assert.ok(match, `Missing production function ${name}`);
    return source.slice(match.index, source.indexOf('\n}\n', match.index) + 2);
  })
  .join('\n');

function routine(input = {}) {
  return {
    id: 'synthetic-routine',
    enabled: true,
    trigger: { type: 'schedule', at: '2001-02-03T04:05:00Z', timezone: 'UTC' },
    action: {
      type: 'send_prompt',
      connectorId: 'vibe',
      targetHostId: 'host',
      input: {
        target: 'autopilot',
        queue: true,
        prompt: 'Synthetic check {{count}}',
      },
    },
    ...input,
  };
}

function harness({
  state: restored,
  store = { queue: [], receipts: new Map() },
} = {}) {
  const state = restored || {
    connectors: [
      {
        id: 'vibe',
        type: 'vibe_kanban',
        enabled: true,
        config: {
          hostBridges: {
            host: {
              baseUrl: 'https://host.invalid',
              projectIds: ['project'],
              repositoryIds: ['repo'],
            },
          },
        },
      },
    ],
    rules: [],
    routines: [],
    routineRuns: [],
    retryQueue: [],
    pendingRoutineEvents: [],
    routineClaims: {},
    routineIdempotency: {},
    routineOccurrences: {},
    routineQueuedPrompts: {},
    routineBuffers: {},
    eventReceipts: {},
  };
  const h = { state, store, logs: [], calls: [], posts: 0, releases: 0 };
  const api = async (_, method, endpoint, payload, baseUrl, meta) => {
    h.calls.push({ method, endpoint, baseUrl });
    if (h.fail) throw new Error('synthetic offline');
    if (endpoint === '/api/automation-actions/status')
      return { hostId: h.hostId || 'host' };
    if (endpoint === '/api/workspaces/autopilot')
      return {
        data: {
          session: { id: h.sessionId || 'session' },
          executor_config: { executor: 'CODEX' },
        },
      };
    if (endpoint.startsWith('/api/automation-actions/receipts/'))
      return (
        store.receipts.get(decodeURIComponent(endpoint.split('/').at(-1))) || {
          status: 'missing',
        }
      );
    if (endpoint.startsWith('/api/sessions/') && endpoint.endsWith('/queue')) {
      if (method === 'GET')
        return structuredClone({
          data: {
            status: store.queue.length ? 'queued' : 'empty',
            messages: store.queue,
          },
        });
      h.posts += 1;
      if (store.receipts.has(meta.idempotencyKey))
        return store.receipts.get(meta.idempotencyKey).response;
      store.queue.push({ id: randomUUID(), data: structuredClone(payload) });
      const response = structuredClone({
        data: { status: 'queued', messages: store.queue },
      });
      store.receipts.set(meta.idempotencyKey, {
        status: 'succeeded',
        action: h.handoff ? 'notification_handoff' : 'queue_prompt',
        response: h.handoff ? null : response,
      });
      if (h.loseResponse) throw new Error('synthetic response lost');
      return h.handoff ? null : response;
    }
    if (endpoint === '/api/state-read') return { data: { work: true } };
    throw new Error(`Unexpected API call: ${method} ${endpoint}`);
  };
  const context = vm.createContext({
    state,
    vm,
    URL,
    Date,
    createHash,
    randomUUID,
    structuredClone,
    RETRY_MAX_ATTEMPTS: 5,
    MAX_LOGS: 500,
    RULE_TIMEOUT_MS: 1000,
    routineInFlight: new Set(),
    routineHostInFlight: new Set(),
    retryInFlight: new Set(),
    autopilotPresence: new Map(),
    cloneData: structuredClone,
    routineRunTrigger,
    validateRoutineScope,
    scheduleOccurrence,
    renderPromptTemplate,
    isIndeterminateActionError,
    carriesRetryExhausted,
    shouldRunGithubIssueSyncRule: () => true,
    githubIssueLinkKey: () => '',
    githubReviewRuleVersion: () => '',
    findConnector: (id) => state.connectors.find((item) => item.id === id),
    log: async (level, message, meta) => h.logs.push({ level, message, meta }),
    persistState: async (strict) => {
      if (strict && h.failStrictWrite)
        throw new Error('synthetic storage failure');
      h.persisted = structuredClone(state);
    },
    errorMessage: (error) => error.message,
    withTimeout: async (promise) => promise,
    retryDelay: () => 60000,
    rememberRoutineOrigin: async () => {},
    releaseClaimedNotifications: async () => {
      h.releases += 1;
    },
    deliversToAutopilot: () => false,
    announceRetryExhausted: async () => {},
    drainPendingRoutineEvents: async () => {},
    enqueueRoutineRetry: async (routine, event, key) =>
      state.retryQueue.push({
        id: randomUUID(),
        ruleId: `routine:${routine.id}`,
        status: 'pending',
        attempts: 1,
        maxAttempts: 5,
        nextAttemptAt: Date.now() + 60000,
        event: { ...event, routineId: routine.id, routineIdempotencyKey: key },
      }),
    vibeApi: api,
    notificationRouting: {
      deliver: async (routine, event, build) => {
        const delivery = await build(event);
        return api(
          null,
          'POST',
          delivery.path,
          delivery.payload,
          'https://host.invalid',
          delivery.meta
        );
      },
    },
  });
  vm.runInContext(functions, context);
  return Object.assign(h, {
    context,
    run: context.runRoutine,
    due: context.runDueRoutines,
    retry: context.processRetryQueue,
    condition: context.routineConditionMatches,
    ruleContext: context.createRuleContext,
  });
}

test('successful one-shots are removed durably without resurrecting their occurrence', async () => {
  const h = harness();
  h.state.routines.push(routine(), routine({ id: 'synthetic-second' }));
  await h.due();
  assert.equal(h.posts, 2);
  assert.equal(h.state.routines.length, 0);
  assert.deepEqual(h.state.routineOccurrences, {});
  assert.equal(h.persisted.routines.length, 0);
  await h.due();
  assert.equal(h.posts, 2);
});

test('stale or disabled routine snapshots do not start a run', async () => {
  const h = harness();
  const stale = routine();
  h.state.routines.push(routine());
  assert.equal((await h.run(stale, {}, 'synthetic-stale')).status, 'skipped');
  h.state.routines = [stale];
  stale.enabled = false;
  assert.equal(
    (await h.run(stale, {}, 'synthetic-disabled')).status,
    'skipped'
  );
  assert.equal(h.state.routineRuns.length, 0);
  assert.equal(h.calls.length, 0);
});

test('an explicitly requested manual run still works for a disabled routine', async () => {
  const h = harness();
  const r = routine({ enabled: false });
  h.state.routines.push(r);
  const result = await h.run(
    r,
    { source: 'manual', type: 'manual' },
    'synthetic-manual'
  );
  assert.equal(result.ok, true);
  assert.equal(h.posts, 1);
});

test('failed one-shots survive restart and are removed only after a successful retry', async () => {
  const h = harness();
  h.state.routines.push(routine());
  h.fail = true;
  await h.due();
  assert.equal(h.state.routines.length, 1);
  assert.equal(h.state.retryQueue.length, 1);
  assert.equal(h.state.routineRuns[0].status, 'retrying');
  const restored = harness({
    state: structuredClone(h.persisted),
    store: h.store,
  });
  await restored.retry({ force: true });
  assert.equal(restored.state.routines.length, 0);
  assert.equal(restored.state.retryQueue.length, 0);
  assert.equal(restored.state.routineRuns[0].status, 'succeeded');
  assert.deepEqual(restored.state.routineOccurrences, {});
});

test('retry success records completion even after the run history has been trimmed', async () => {
  const h = harness();
  const r = routine();
  h.state.routines.push(r);
  h.fail = true;
  await h.run(r, { type: 'schedule' }, 'synthetic-key');
  h.state.routineRuns = [];
  h.fail = false;
  await h.retry({ force: true });
  assert.equal(h.state.routines.length, 0);
  assert.ok(h.state.routineIdempotency['synthetic-key']);
  assert.equal(h.state.routineClaims['synthetic-key'].status, 'succeeded');
});

test('exhausted one-shots remain available for manual recovery', async () => {
  const h = harness();
  const r = routine();
  h.state.routines.push(r);
  h.fail = true;
  await h.run(r, { type: 'schedule' }, 'synthetic-key');
  h.state.retryQueue[0].maxAttempts = 2;
  await h.retry({ force: true });
  assert.equal(h.state.routines.length, 1);
  assert.equal(h.state.retryQueue[0].status, 'exhausted');
});

test('skipped one-shots are recorded and kept', async () => {
  const h = harness();
  const r = routine();
  h.state.routines.push(r);
  h.state.routineQueuedPrompts[r.id] = {
    sessionId: 'session',
    targetHostId: 'host',
    messageId: 'pending',
  };
  h.store.queue.push({
    id: 'pending',
    data: { message: 'Synthetic earlier check' },
  });
  const result = await h.run(r, {}, 'synthetic-key');
  assert.match(result.run.skipped, /still queued/);
  assert.equal(h.state.routines.length, 1);
  assert.equal(h.posts, 0);
});

test('queued prompts dedupe by routine across restart and changed template input, then resume after consumption', async () => {
  const h = harness();
  const r = routine({
    trigger: { type: 'schedule', cron: '* * * * *', timezone: 'UTC' },
  });
  h.state.routines.push(r);
  await h.run(r, { count: 1 }, 'synthetic-first');
  const restarted = harness({
    state: structuredClone(h.persisted),
    store: h.store,
  });
  const result = await restarted.run(
    restarted.state.routines[0],
    { count: 2 },
    'synthetic-second'
  );
  assert.match(result.run.skipped, /still queued/);
  assert.equal(restarted.posts, 0);
  assert.equal(restarted.store.queue.length, 1);
  assert.ok(restarted.logs.some((entry) => /still queued/.test(entry.message)));
  restarted.store.queue = [];
  await restarted.run(
    restarted.state.routines[0],
    { count: 3 },
    'synthetic-third'
  );
  assert.equal(restarted.posts, 1);
  assert.equal(restarted.store.queue[0].data.message, 'Synthetic check 3');
});

test('a lost queue response recovers the message id from the host receipt after restart', async () => {
  const h = harness();
  const r = routine({ trigger: { type: 'vk_event' } });
  h.state.routines.push(r);
  h.loseResponse = true;
  await h.run(r, { count: 1 }, 'synthetic-first');
  assert.equal(h.store.queue.length, 1);
  const restored = structuredClone(h.persisted);
  recoverInterruptedAutomationState(restored);
  const restarted = harness({ state: restored, store: h.store });
  const result = await restarted.run(
    restored.routines[0],
    { count: 2 },
    'synthetic-second'
  );
  assert.match(result.run.skipped, /still queued/);
  await restarted.retry({ force: true });
  assert.equal(restarted.posts, 0);
  assert.equal(h.store.queue.length, 1);
});

test('an uncertain prior queue admission blocks new sends until its outcome is known', async () => {
  const h = harness();
  const r = routine({ trigger: { type: 'vk_event' } });
  h.state.routines.push(r);
  h.state.routineQueuedPrompts[r.id] = {
    sessionId: 'session',
    targetHostId: 'host',
    idempotencyKey: 'synthetic-prior',
  };
  h.store.receipts.set('synthetic-prior', { status: 'running' });
  const result = await h.run(r, {}, 'synthetic-key');
  assert.equal(result.run.status, 'retrying');
  assert.equal(h.posts, 0);
});

test('a queue intent must be durable before sending the prompt', async () => {
  const h = harness();
  const r = routine({ trigger: { type: 'vk_event' } });
  h.state.routines.push(r);
  h.failStrictWrite = true;
  const result = await h.run(r, {}, 'synthetic-key');
  assert.equal(result.run.status, 'retrying');
  assert.equal(h.posts, 0);
});

test('a filtered notification batch keeps the sent prompt identity across a lost reply and restart', async () => {
  const h = harness();
  const r = routine({ trigger: { type: 'vk_event' } });
  h.state.routines.push(r);
  h.handoff = true;
  let delivery;
  h.context.notificationRouting = createNotificationRouting({
    instanceId: 'synthetic-instance',
    api: async (_, method, endpoint, payload, onHost, meta) => {
      if (endpoint.endsWith('/renew-claim')) {
        if (endpoint.includes('/expired/'))
          throw Object.assign(new Error('synthetic expired claim'), {
            status: 409,
          });
        return {};
      }
      if (endpoint.endsWith('/handoff')) {
        delivery = payload.handoff;
        return {};
      }
      if (endpoint.endsWith('/notification-handoff'))
        return h.context.vibeApi(
          null,
          'POST',
          delivery.path,
          delivery.payload,
          'https://host.invalid',
          meta
        );
      throw new Error(`Unexpected notification API: ${method} ${endpoint}`);
    },
  });
  const alert = (id) => ({
    id,
    notificationId: id,
    notificationRevision: 1,
    notificationClaim: {
      lease_id: 'synthetic-lease',
      claim_token: 'synthetic-claim',
    },
  });
  h.loseResponse = true;
  await h.run(
    r,
    {
      type: 'vk_event_batch',
      count: 2,
      events: [alert('expired'), alert('live')],
    },
    'synthetic-first'
  );
  assert.equal(h.store.queue[0].data.message, 'Synthetic check 1');
  const restarted = harness({
    state: structuredClone(h.persisted),
    store: h.store,
  });
  const result = await restarted.run(
    restarted.state.routines[0],
    { count: 3 },
    'synthetic-second'
  );
  assert.match(result.run.skipped, /still queued/);
  assert.equal(restarted.store.queue.length, 1);
  assert.equal(restarted.posts, 0);
});

for (const loseResponse of [false, true]) {
  test(`notification handoffs dedupe queued messages with ${loseResponse ? 'a lost response' : 'a bodyless response'}`, async () => {
    const h = harness();
    const r = routine({ trigger: { type: 'vk_event' } });
    h.state.routines.push(r);
    h.handoff = true;
    h.loseResponse = loseResponse;
    h.failStrictWrite = true;
    await h.run(
      r,
      { count: 1, notificationClaim: { lease_id: 'synthetic-lease' } },
      'synthetic-first'
    );
    assert.equal(h.store.queue.length, 1);
    const restarted = harness({
      state: structuredClone(h.persisted),
      store: h.store,
    });
    const result = await restarted.run(
      restarted.state.routines[0],
      { count: 2, notificationClaim: { lease_id: 'synthetic-lease' } },
      'synthetic-second'
    );
    assert.match(result.run.skipped, /still queued/);
    assert.equal(restarted.posts, 0);
    assert.equal(restarted.releases, 1);
  });
}

test('different routines and a replaced Autopilot session queue independently', async () => {
  const h = harness();
  const first = routine({ trigger: { type: 'vk_event' } });
  const second = routine({
    id: 'synthetic-other',
    trigger: { type: 'vk_event' },
  });
  h.state.routines.push(first, second);
  await h.run(first, {}, 'synthetic-first');
  await h.run(second, {}, 'synthetic-second');
  assert.equal(h.posts, 2);
  h.sessionId = 'synthetic-new-session';
  await h.run(first, {}, 'synthetic-third');
  assert.equal(h.posts, 3);
});

test('explicit session queues use the same duplicate check', async () => {
  const h = harness();
  const r = routine({ trigger: { type: 'vk_event' } });
  r.action.input = {
    queue: true,
    sessionId: 'session',
    prompt: 'Synthetic explicit',
    executor_config: { executor: 'CODEX' },
    scope: { projectId: 'project', repositoryIds: ['repo'] },
  };
  h.state.routines.push(r);
  await h.run(r, {}, 'synthetic-first');
  const result = await h.run(r, {}, 'synthetic-second');
  assert.match(result.run.skipped, /still queued/);
  assert.equal(h.posts, 1);
});

test('condition rules can read their bound host while mutation and HTTP actions stay absent', async () => {
  const h = harness();
  h.state.rules.push({
    id: 'synthetic-condition',
    kind: 'condition',
    enabled: true,
    script:
      'async function handle(event, ctx) { return (await ctx.actions.vibe.hostBridgeGet("/api/state-read")).data.work; }',
  });
  const r = routine({ condition: { ruleId: 'synthetic-condition' } });
  assert.equal(await h.condition(r, { type: 'schedule' }), true);
  const ctx = h.ruleContext(
    {},
    { targetHostId: 'host', connectorId: 'vibe' },
    true
  );
  assert.deepEqual(Object.keys(ctx.actions.vibe), ['hostBridgeGet']);
  assert.equal(ctx.artifacts, undefined);
  assert.equal(ctx.actions.http, undefined);
  for (const path of [
    'https://other.invalid/api/state-read',
    '/api/../outside',
    '//other.invalid/api/state-read',
  ])
    await assert.rejects(ctx.actions.vibe.hostBridgeGet(path), /relative/);
  h.hostId = 'synthetic-wrong-host';
  await assert.rejects(
    ctx.actions.vibe.hostBridgeGet('/api/state-read'),
    /identity mismatch/
  );
});

test('host condition reads preserve the original source connector and target fields', async () => {
  const h = harness();
  h.state.rules.push({
    id: 'synthetic-source-condition',
    kind: 'condition',
    enabled: true,
    script:
      'async function handle(event, ctx) { return event.connectorId === "events" && event.targetHostId === "source-host" && (await ctx.actions.vibe.hostBridgeGet("/api/state-read")).data.work; }',
  });
  const r = routine({ condition: { ruleId: 'synthetic-source-condition' } });
  const event = {
    type: 'vk_event',
    source: 'vibe',
    connectorId: 'events',
    targetHostId: 'source-host',
  };
  assert.equal(await h.condition(r, event), true);
  assert.equal(event.connectorId, 'events');
  assert.equal(event.targetHostId, 'source-host');
  assert.equal(h.calls.at(-1).baseUrl, 'https://host.invalid');
});

test('a false host condition consumes the occurrence without sending or deleting the one-shot', async () => {
  const h = harness();
  h.state.rules.push({
    id: 'synthetic-empty-condition',
    kind: 'condition',
    enabled: true,
    script:
      'async function handle(event, ctx) { return !(await ctx.actions.vibe.hostBridgeGet("/api/state-read")).data.work; }',
  });
  h.state.routines.push(
    routine({ condition: { ruleId: 'synthetic-empty-condition' } })
  );
  await h.due();
  const reads = h.calls.length;
  await h.due();
  assert.equal(reads, 2);
  assert.equal(h.calls.length, reads);
  assert.equal(h.posts, 0);
  assert.equal(h.state.routines.length, 1);
  assert.equal(h.state.routineRuns.length, 0);
  assert.ok(h.state.routineOccurrences['synthetic-routine']);
});

test('retention prunes old and deleted-routine records while preserving live work and occurrence fences', () => {
  const h = harness();
  const now = Date.parse('2032-06-15T00:00:00Z');
  const old = now - 8 * 24 * 3600000;
  h.state.routines.push(routine({ id: 'active' }));
  for (const [key, routineId, updatedAt, status] of [
    ['expired', 'active', old, 'succeeded'],
    ['fresh', 'active', now, 'succeeded'],
    ['orphan', 'deleted', now, 'succeeded'],
    ['running', 'active', old, 'running'],
    ['retry', 'active', old, 'retrying'],
  ]) {
    h.state.routineClaims[key] = { runId: key, routineId, updatedAt, status };
    h.state.routineIdempotency[key] = key;
  }
  h.state.retryQueue.push({
    event: { routineId: 'active', routineIdempotencyKey: 'retry' },
  });
  h.state.retryQueue.push({
    ruleId: 'routine:deleted',
    event: { routineId: 'deleted', routineIdempotencyKey: 'orphan' },
  });
  h.state.pendingRoutineEvents.push({
    routineId: 'deleted',
    idempotencyKey: 'orphan',
  });
  h.state.routineOccurrences = {
    active: 'once:2001-02-03T04:05:00.000Z',
    deleted: 'obsolete',
  };
  h.state.eventReceipts = {
    old: { status: 'succeeded', receivedAt: old },
    fresh: { status: 'succeeded', receivedAt: now },
    running: { status: 'running', receivedAt: old },
  };
  pruneAutomationState(h.state, now);
  assert.deepEqual(Object.keys(h.state.routineClaims).sort(), [
    'fresh',
    'retry',
    'running',
  ]);
  assert.deepEqual(Object.keys(h.state.routineIdempotency).sort(), [
    'fresh',
    'retry',
    'running',
  ]);
  assert.deepEqual(Object.keys(h.state.eventReceipts).sort(), [
    'fresh',
    'running',
  ]);
  assert.deepEqual(Object.keys(h.state.routineOccurrences), ['active']);
  assert.equal(h.state.retryQueue.length, 1);
  assert.equal(h.state.pendingRoutineEvents.length, 0);
});

test('legacy claims expire without a retained run and deleted scheduled routines are recognized', () => {
  const h = harness();
  const now = Date.parse('2032-06-15T00:00:00Z');
  h.state.routines.push(routine({ id: 'active' }));
  h.state.routineClaims = {
    opaque: { runId: 'trimmed', status: 'succeeded' },
    'deleted:once:2001-02-03T04:05:00.000Z': {
      runId: 'deleted-run',
      status: 'succeeded',
    },
  };
  h.state.routineIdempotency = {
    opaque: 'trimmed',
    'active:event': 'legacy-run',
  };
  pruneAutomationState(h.state, now);
  assert.equal(Object.keys(h.state.routineClaims).length, 2);
  pruneAutomationState(h.state, now + 8 * 24 * 3600000);
  assert.deepEqual(h.state.routineClaims, {});
  assert.deepEqual(h.state.routineIdempotency, {});
});

test('interrupted claims without retained run history become exhausted instead of living forever', () => {
  const state = {
    routineClaims: { 'synthetic-key': { runId: 'trimmed', status: 'running' } },
  };
  recoverInterruptedAutomationState(state);
  assert.equal(state.routineClaims['synthetic-key'].status, 'exhausted');
  assert.ok(state.routineClaims['synthetic-key'].updatedAt);
});

test('exhausted claims expire while their retry records still prevent automatic replay and allow manual recovery', async () => {
  const h = harness();
  const r = routine();
  h.state.routines.push(r);
  h.fail = true;
  await h.run(r, { type: 'schedule' }, 'synthetic-key');
  h.state.retryQueue[0].maxAttempts = 2;
  await h.retry({ force: true });
  assert.equal(h.state.retryQueue[0].status, 'exhausted');
  h.state.routineRuns = [];
  h.state.routineClaims['synthetic-key'].updatedAt = Date.now() - 6 * 86400000;
  pruneAutomationState(h.state);
  assert.ok(h.state.routineClaims['synthetic-key']);
  h.state.routineClaims['synthetic-key'].updatedAt = Date.now() - 30 * 86400000;
  pruneAutomationState(h.state);
  assert.equal(h.state.routineClaims['synthetic-key'], undefined);
  assert.equal(h.state.routines.length, 1);
  assert.equal(h.state.retryQueue.length, 1);
  h.fail = false;
  const redelivery = await h.run(r, { type: 'schedule' }, 'synthetic-key');
  assert.equal(redelivery.status, 'exhausted');
  assert.equal(h.posts, 0);
  await h.retry({ force: true, includeExhausted: true });
  assert.equal(h.posts, 1);
  assert.equal(h.state.routines.length, 0);
  assert.equal(h.state.retryQueue.length, 0);
  assert.ok(h.state.routineIdempotency['synthetic-key']);
});
