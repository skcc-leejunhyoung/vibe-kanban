import assert from 'node:assert/strict';
import test from 'node:test';
import { previewAutopilot, routeAutopilot } from './autopilot-router.mjs';

const executionId = '10000000-0000-4000-8000-000000000001';
const hostId = '10000000-0000-4000-8000-000000000002';
const workspaceId = '10000000-0000-4000-8000-000000000003';
const completion = {
  id: 'synthetic-completion',
  kind: 'process.completed',
  executionId,
  hostId,
  workspaceId,
};
function fixture() {
  const h = {
    calls: 0,
    posts: 0,
    writes: 0,
    record: {},
    guard: {
      hostId: 'synthetic-machine',
      execution_id: executionId,
      workspace_id: workspaceId,
      eligible: true,
      version: 'a'.repeat(64),
      result_hash: 'b'.repeat(64),
    },
  };
  h.receipt = {
    action: 'autopilot_result',
    status: 'recorded',
    execution_id: executionId,
    workspace_id: workspaceId,
    result_hash: h.guard.result_hash,
  };
  h.options = {
    event: completion,
    record: h.record,
    minConfidence: 0.95,
    apiKey: 'synthetic-key',
    persist: async () => {
      h.writes++;
      if (h.failWrite) throw new Error('synthetic disk failure');
      h.disk = structuredClone(h.record);
    },
    evaluate: async () => {
      h.calls++;
      return {
        status: 'completed',
        results: [
          {
            event_index: 0,
            source: 'decisions',
            route: 'routine_result',
            truncated: false,
            confidence: 0.99,
            evidence_hash: h.guard.result_hash,
          },
        ],
      };
    },
    resolveHost: async () => ({
      machineId: 'synthetic-machine',
      get: async () => {
        if (h.offline) throw new Error('synthetic offline');
        return h.guard;
      },
      post: async () => {
        h.posts++;
        if (h.conflict)
          throw Object.assign(new Error('changed'), { status: 409 });
        h.guard.receipt = h.receipt;
        if (h.lost) throw new Error('lost reply');
        return h.receipt;
      },
    }),
    completeNotification: async () => {
      h.acks = (h.acks || 0) + 1;
      if (h.lostAck) throw new Error('lost acknowledgement');
      return true;
    },
    hydrateEvent: async (item) => ({
      ...item,
      ...completion,
      kind: item.kind,
      id: item.id,
    }),
  };
  h.route = (extra = {}) => routeAutopilot({ ...h.options, ...extra });
  return h;
}

test('only fresh, confidence-qualified evidence can suppress an agent; disposition is durable', async () => {
  const h = fixture();
  assert.equal((await h.route()).remaining.length, 0);
  assert.equal(h.posts, 1);
  assert.equal(h.calls, 1);
  assert.equal(h.disk.outcome.handled.length, 1);
  await h.route();
  assert.equal(h.posts, 1);
  assert.equal(h.calls, 1);
});

test('low confidence, non-routine routes and mismatched evidence stay on the agent path', async () => {
  for (const patch of [
    { truncated: true },
    { confidence: 0.9 },
    { route: 'needs_user' },
    { route: 'needs_investigation' },
    { evidence_hash: 'c'.repeat(64) },
    { source: 'fallback' },
  ]) {
    const h = fixture();
    const evaluate = h.options.evaluate;
    h.options.evaluate = async () => {
      const result = await evaluate();
      Object.assign(result.results[0], patch);
      return result;
    };
    assert.equal((await h.route()).remaining.length, 1);
    assert.equal(h.posts, 0);
  }
});

test('protected batches never call Decisions or host mutation', async () => {
  for (const kind of [
    'drawer.comment',
    'approval.requested',
    'review.requested',
    'unknown',
  ]) {
    const h = fixture();
    const result = await h.route({ event: { events: [completion, { kind }] } });
    assert.equal(result.remaining.length, 2);
    assert.equal(h.calls, 0);
    assert.equal(h.posts, 0);
  }
});

test('shadow distinguishes a fully qualified batch from partial and protected batches', async () => {
  const h = fixture();
  const preview = (events) =>
    previewAutopilot({ ...h.options, event: { events } });
  const full = await preview([completion]);
  assert.equal(full.routing_preview.would_suppress, true);
  assert.equal(full.delivery, 'unchanged');
  const partial = await preview([
    { ...completion, id: 'synthetic-no-identity', executionId: null },
    completion,
  ]);
  assert.equal(partial.routing_preview.would_suppress, false);
  assert.equal(partial.routing_preview.remaining_events, 1);
  assert.deepEqual(partial.routing_preview.exclusions, { missing_identity: 1 });
  assert.equal(partial.results[0].event_index, 1);
  const protectedBatch = await preview([
    completion,
    { kind: 'approval.pending' },
  ]);
  assert.equal(protectedBatch.routing_preview.eligible_events, 0);
  assert.equal(protectedBatch.routing_preview.would_suppress, false);
  assert.deepEqual(protectedBatch.routing_preview.exclusions, {
    protected_batch: 2,
  });
  assert.equal(h.calls, 2);
  assert.equal(h.posts, 0);
  assert.equal(h.writes, 0);
});

test('shadow keeps claimed cloud completions on the agent path until acknowledgement can be proved', async () => {
  const h = fixture();
  const result = await previewAutopilot({
    ...h.options,
    event: {
      ...completion,
      kind: 'cloud.notification',
      notificationClaim: {
        lease_id: 'synthetic-lease',
        claim_token: 'synthetic-token',
      },
    },
  });
  assert.equal(result.results[0].route, 'routine_result');
  assert.equal(result.routing_preview.eligible_events, 1);
  assert.equal(result.routing_preview.would_suppress, false);
  assert.deepEqual(result.routing_preview.exclusions, {
    cloud_confirmation_required: 1,
  });
  assert.equal(h.posts, 0);
  assert.equal(h.acks, undefined);
  assert.ok(!JSON.stringify(result).includes('synthetic-token'));
});

test('lost host response replays native proof after restart without another model request', async () => {
  const h = fixture();
  h.lost = true;
  await assert.rejects(h.route(), { indeterminate: true });
  Object.assign(h.record, structuredClone(h.disk));
  h.lost = false;
  assert.equal((await h.route()).remaining.length, 0);
  assert.equal(h.calls, 1);
  assert.equal(h.posts, 1);
});

test('uncertain native mutation and unreachable evidence hold retry instead of dispatching an agent', async () => {
  const h = fixture();
  h.lost = true;
  await assert.rejects(h.route(), { indeterminate: true, retryable: true });
  h.offline = true;
  await assert.rejects(h.route(), { indeterminate: true, retryable: true });
  assert.equal(h.calls, 1);
});

test('an empty result reply recovers native proof without falling through to an agent', async () => {
  const h = fixture();
  const resolve = h.options.resolveHost;
  h.options.resolveHost = async (...args) => {
    const host = await resolve(...args);
    const post = host.post;
    host.post = async (...args) => {
      await post(...args);
      return null;
    };
    return host;
  };
  await assert.rejects(h.route(), { indeterminate: true, retryable: true });
  assert.equal((await h.route()).remaining.length, 0);
  assert.equal(h.calls, 1);
  assert.equal(h.posts, 1);
});

test('cloud receipt recovery stays pending during a source outage without a new native action', async () => {
  const h = fixture();
  h.guard.receipt = h.receipt;
  h.lostAck = true;
  const event = {
    id: 'synthetic-existing-cloud-result',
    kind: 'cloud.notification',
    notificationId: 'synthetic-notification',
    notificationRevision: 1,
    notificationClaim: { lease_id: 'synthetic-lease' },
  };
  await assert.rejects(h.route({ event }), {
    indeterminate: true,
    retryable: true,
  });
  h.offline = true;
  await assert.rejects(h.route({ event }), {
    indeterminate: true,
    retryable: true,
  });
  h.offline = h.lostAck = false;
  assert.equal((await h.route({ event })).remaining.length, 0);
  assert.equal(h.calls, 0);
  assert.equal(h.posts, 0);
});

test('disk failure prevents paid calls and prevents agent admission with an unfrozen disposition', async () => {
  const h = fixture();
  h.failWrite = true;
  await assert.rejects(h.route());
  assert.equal(h.calls, 0);
  assert.equal(h.posts, 0);
});

test('fresh host rejection falls back once and cannot flip to handled on an agent retry', async () => {
  const h = fixture();
  h.conflict = true;
  assert.equal((await h.route()).remaining.length, 1);
  h.conflict = false;
  h.guard.receipt = h.receipt;
  assert.equal((await h.route()).remaining.length, 1);
  assert.equal(h.posts, 1);
});

test('cloud acknowledgement loss recovers binding and proof without persisting claim tokens', async () => {
  const h = fixture();
  h.lostAck = true;
  const event = {
    id: 'synthetic-cloud',
    kind: 'cloud.notification',
    notificationId: 'synthetic-notification',
    notificationRevision: 2,
    notificationClaim: { claim_token: 'synthetic-secret' },
  };
  await assert.rejects(h.route({ event }), { indeterminate: true });
  assert.ok(!JSON.stringify(h.disk).includes('synthetic-secret'));
  h.lostAck = false;
  const result = await h.route({ event });
  assert.equal(result.remaining.length, 0);
  assert.equal(h.calls, 1);
  assert.equal(h.posts, 1);
  assert.equal(h.acks, 2);
});

test('a pending paid observation is never charged again after restart', async () => {
  const h = fixture();
  h.record.candidate = { status: 'pending' };
  h.record.candidate_ids = [];
  assert.equal((await h.route()).remaining.length, 1);
  assert.equal(h.calls, 0);
  assert.equal(h.posts, 0);
});

test('rollback recovers existing receipts but does not begin new suppression actions', async () => {
  const h = fixture();
  assert.equal((await h.route({ allowNewActions: false })).remaining.length, 1);
  assert.equal(h.calls, 0);
  assert.equal(h.posts, 0);
  const replay = fixture();
  replay.guard.receipt = replay.receipt;
  assert.equal(
    (await replay.route({ allowNewActions: false })).remaining.length,
    0
  );
});

test('an unresponsive host is bounded and falls back without a paid request', async () => {
  const h = fixture();
  const start = Date.now();
  const result = await previewAutopilot({
    ...h.options,
    resolveHost: () => new Promise(() => {}),
  });
  assert.equal(result.routing_preview.remaining_events, 1);
  assert.deepEqual(result.routing_preview.exclusions, { timeout: 1 });
  assert.equal(h.calls, 0);
  assert.equal(h.posts, 0);
  assert.ok(Date.now() - start < 5000);
});

test('shadow separates execution policy from host lookup failures', async () => {
  const h = fixture();
  h.guard.eligible = false;
  const ineligible = await previewAutopilot(h.options);
  assert.deepEqual(ineligible.routing_preview.exclusions, {
    ineligible_execution: 1,
  });
  h.offline = true;
  const unavailable = await previewAutopilot(h.options);
  assert.deepEqual(unavailable.routing_preview.exclusions, {
    host_unavailable: 1,
  });
  assert.equal(h.calls, 0);
});

test('duplicate event identities cannot borrow a classification or trigger a new host mutation', async () => {
  const h = fixture();
  const event = { events: [completion, { ...completion }] };
  const result = await previewAutopilot({ ...h.options, event });
  assert.deepEqual(result.routing_preview.exclusions, { duplicate_event: 2 });
  assert.equal((await h.route({ event })).remaining.length, 2);
  assert.equal(h.calls, 0);
  assert.equal(h.posts, 0);
});
