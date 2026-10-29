import test from "node:test";
import assert from "node:assert/strict";
import { createNotificationRouting } from "./notification-routing.mjs";
import { eventMatchesRoutine, redactEvent } from "./routines.mjs";

import { journalEventToWorkerEvent } from "./vibe-events.mjs";

const routine = { id: "test-routine", action: { targetHostId: "test-host" } };
function fixture(instanceId = "instance") {
  const calls = [];
  let recovered = [];
  let receipt = { status: "missing" };
  let failure;
  let protocol = 2;
  const api = async (_routine, method, path, payload, host, meta) => {
    calls.push({ method, path, payload, host, meta });
    if (path.startsWith("/v1/notifications/"))
      assert.match(path, /\/(claim|renew-claim|handoff|consume|release)$/);
    if (failure?.(path, payload))
      throw Object.assign(new Error("expired"), { status: 409 });
    if (path === "/v1/autopilot-notification-leases") return { id: "lease", protocol };
    if (path.startsWith("/v1/notification-claims?"))
      return { claims: recovered };
    if (path.includes("/receipts/")) return receipt;
    return { data: { claim_token: "claim" } };
  };
  const routing = createNotificationRouting({ api, instanceId });
  const event = (id = "alert") => ({
    notificationId: id,
    notificationRevision: 1,
    notificationIntent: "raw_event",
  });
  return {
    routing,
    calls,
    event,
    setRecovered(value) {
      recovered = value;
    },
    setReceipt(value) {
      receipt = value;
    },
    setProtocol(value) { protocol = value; },
    setFailure(value) {
      failure = value;
    },
  };
}

test("raw alerts require a lease; user reports do not become claims", async () => {
  const f = fixture();
  assert.equal(await f.routing.claim(routine, f.event()), false);
  assert.equal(
    await f.routing.claim(routine, { notificationIntent: "user_report" }),
    true,
  );
  assert.equal(f.calls.length, 0);
  await f.routing.register(routine, ["cloud.notification"], true);
  assert.equal(await f.routing.claim(routine, f.event()), true);
  assert.equal(await f.routing.claim(routine, f.event()), false);
  assert.equal(f.calls.filter((c) => c.path.endsWith("/claim")).length, 1);
});

test("batch is frozen before the host stages and admits it", async () => {
  const f = fixture();
  await f.routing.register(routine, [], true);
  const events = [f.event("b"), f.event("a")];
  for (const event of events) await f.routing.claim(routine, event);
  await f.routing.deliver(
    routine,
    { events },
    {
      path: "/queue",
      payload: { message: "synthetic" },
      meta: { idempotencyKey: "fixed-batch" },
    },
  );
  const handoffs = f.calls.filter((c) => c.path.endsWith("/handoff"));
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].payload.members.length, 2);
  assert.equal(handoffs[0].payload.handoff_key, "fixed-batch");
  const paths = f.calls.map((c) => c.path);
  assert.ok(
    paths.indexOf("/queue/notification-handoff") > paths.indexOf("/v1/notifications/a/handoff"),
  );
  assert.equal(paths.some((path) => path.endsWith("/consume")), false);
});

test("expired revision prevents any queue side effect", async () => {
  const f = fixture();
  await f.routing.register(routine, [], true);
  const event = f.event();
  await f.routing.claim(routine, event);
  f.setFailure((path) => path.endsWith("/renew-claim"));
  await assert.rejects(
    f.routing.deliver(routine, event, {
      path: "/queue",
      meta: { idempotencyKey: "fixed" },
    }),
  );
  assert.equal(
    f.calls.some((c) => c.path === "/queue"),
    false,
  );
});

test("restart recovers claims independently from local event receipts", async () => {
  const f = fixture();
  await f.routing.register(routine, [], true);
  f.setRecovered([
    {
      id: "alert",
      revision: 2,
      state: "autopilot_claimed",
      claim_token: "old-claim",
      type: "issue_comment_added",
    },
  ]);
  const events = await f.routing.recover(routine);
  assert.equal(events.length, 1);
  assert.equal(events[0].notificationRevision, 2);
  assert.equal(events[0].notificationClaim.claim_token, "old-claim");
});

test("lost queue response uses receipt and never sends another prompt", async () => {
  const f = fixture();
  await f.routing.register(routine, [], true);
  f.setRecovered([
    {
      id: "alert",
      revision: 1,
      claim_token: "claim",
      handoff_key: "stable",
      handoff: {
        path: "/queue",
        payload: { message: "saved" },
        meta: { idempotencyKey: "stable" },
      },
    },
  ]);
  f.setReceipt({ status: "succeeded" });
  await f.routing.recover(routine);
  assert.equal(f.calls.some((c) => c.path.endsWith("/consume")), false);
  assert.equal(
    f.calls.some((c) => c.path === "/queue"),
    false,
  );
  f.setReceipt({ status: "running" });
  f.calls.length = 0;
  await f.routing.recover(routine);
  assert.equal(
    f.calls.some((c) => c.path === "/queue" || c.path.endsWith("/consume")),
    false,
  );
});

test("missing receipt retries only the saved handoff key and body", async () => {
  const f = fixture();
  await f.routing.register(routine, [], true);
  f.setRecovered([
    {
      id: "alert",
      revision: 1,
      claim_token: "claim",
      handoff_key: "stable",
      handoff: {
        path: "/queue",
        payload: { message: "saved" },
        meta: { idempotencyKey: "stable" },
      },
    },
  ]);
  await f.routing.recover(routine);
  const sent = f.calls.find((c) => c.path === "/queue/notification-handoff");
  assert.deepEqual(sent.payload.handoff.payload, { message: "saved" });
  assert.equal(sent.meta.idempotencyKey, "stable");
});

test("release and revoke never PATCH user read/archive state", async () => {
  const f = fixture();
  await f.routing.register(routine, [], true);
  const event = f.event();
  await f.routing.claim(routine, event);
  await f.routing.release(routine, event);
  await f.routing.register(routine, [], false);
  assert.ok(f.calls.some((c) => c.path.endsWith("/release")));
  assert.equal(f.calls.at(-1).payload.revoke, true);
  assert.equal(
    f.calls.some((c) => c.method === "PATCH"),
    false,
  );
});

test("restored local buffers renew their central claims without adding a duplicate event", async () => {
  const f = fixture();
  await f.routing.register(routine, [], true);
  const event = f.event();
  event.notificationClaim = { lease_id: "lease", claim_token: "saved-claim" };
  f.routing.restore(event);
  f.setRecovered([
    {
      id: "alert",
      revision: 1,
      claim_token: "saved-claim",
      type: "issue_comment_added",
    },
  ]);
  assert.deepEqual(await f.routing.recover(routine), []);
  assert.ok(f.calls.some((c) => c.path.endsWith("/renew-claim")));
});

test("a redacted restored buffer refreshes its token from the central claim", async () => {
  const f = fixture();
  await f.routing.register(routine, [], true);
  const restored = redactEvent({
    ...f.event(),
    notificationClaim: { lease_id: "lease", claim_token: "saved-claim" },
  });
  assert.equal(restored.notificationClaim.claim_token, undefined);
  f.routing.restore(restored);
  f.setRecovered([{ id: "alert", revision: 1, claim_token: "saved-claim" }]);
  f.setFailure(
    (path, payload) =>
      path.endsWith("/renew-claim") && payload.claim_token !== "saved-claim",
  );
  assert.deepEqual(await f.routing.recover(routine), []);
  assert.equal(f.calls.at(-1).payload.claim_token, "saved-claim");
  assert.equal(restored.notificationClaim.claim_token, undefined);
});

test("a redacted retry uses its matching live claim without persisting the token", async () => {
  const f = fixture();
  await f.routing.register(routine, [], true);
  const original = f.event();
  await f.routing.claim(routine, original);
  const retry = redactEvent(original);
  assert.equal(retry.notificationClaim.claim_token, undefined);
  f.setFailure(
    (path, payload) =>
      path.endsWith("/renew-claim") && payload.claim_token !== "claim",
  );
  await f.routing.deliver(routine, retry, {
    path: "/queue",
    payload: {},
    meta: { idempotencyKey: "synthetic-retry" },
  });
  assert.ok(f.calls.some((c) => c.path === "/queue/notification-handoff"));
  assert.equal(retry.notificationClaim.claim_token, undefined);
});

test("a redacted retry cannot borrow a token from another revision or lease", async () => {
  for (const mismatch of ["revision", "lease"]) {
    const f = fixture();
    await f.routing.register(routine, [], true);
    const original = f.event();
    await f.routing.claim(routine, original);
    const retry = redactEvent(original);
    if (mismatch === "revision") retry.notificationRevision++;
    else retry.notificationClaim.lease_id = "another-lease";
    f.setFailure(
      (path, payload) => path.endsWith("/renew-claim") && !payload.claim_token,
    );
    await assert.rejects(
      f.routing.deliver(routine, retry, {
        path: "/queue",
        meta: { idempotencyKey: "synthetic-stale-retry" },
      }),
    );
    assert.equal(
      f.calls.some((c) => c.path === "/queue"),
      false,
    );
    assert.equal(f.calls.at(-1).payload.claim_token, undefined);
  }
});

test("a false condition releases a pending alert immediately, without claiming reports", async () => {
  const f = fixture();
  await f.routing.register(routine, [], true);
  await f.routing.releasePending(routine, f.event());
  const release = f.calls.find((c) => c.path.endsWith("/release"));
  assert.equal(release.payload.claim_token, undefined);
  const count = f.calls.length;
  await f.routing.releasePending(routine, {
    ...f.event(),
    notificationIntent: "user_report",
  });
  assert.equal(f.calls.length, count);
});
 test('recovered cloud notifications must preserve the host filter of the journal event', async () => {
  const routine = { id: 'synthetic-cloud-routine', enabled: true, trigger: { type: 'vk_event', kinds: ['cloud.notification'], hosts: ['cloud'] }, action: { targetHostId: 'synthetic-host' } };
  const id = '00000000-0000-4000-8000-000000000001';
  const original = journalEventToWorkerEvent({ cursor: 1, kind: 'cloud.notification', host_id: null, host_name: 'cloud', data: { id, type: 'workspace_task_completed', revision: 1, intent: 'raw_event' } });
  assert.equal(eventMatchesRoutine(routine, original), true);
  const routing = createNotificationRouting({ instanceId: 'synthetic-instance', api: async (_r, _method, path) => {
    if (path === '/v1/autopilot-notification-leases') return { id: 'synthetic-lease', protocol: 2 };
    return { claims: [{ id, revision: 1, state: 'autopilot_pending', type: 'workspace_task_completed', host_id: 'synthetic-host' }] };
  } });
  await routing.register(routine, [], true);
  const [recovered] = await routing.recover(routine);
  assert.equal(eventMatchesRoutine(routine, recovered), true, 'the same alert is rejected and released by reconciliation after recovery');
 });

 test('included Autopilot events reach ordinary routines but cannot wake Autopilot', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const { deliversToAutopilot } = await import('./vibe-events.mjs');
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function dispatchRoutineEvent(');
  const end = source.indexOf("// The routine's Autopilot host:", start);
  const ordinary = { id: 'synthetic-notify', enabled: true, trigger: { type: 'vk_event', kinds: ['process.completed'] }, action: { type: 'notification' } };
  const autopilot = { ...ordinary, id: 'synthetic-autopilot', action: { type: 'send_prompt', input: { target: 'autopilot' } } };
  const runs = [];
  const context = { state: { routines: [ordinary, autopilot], routineOrigins: {} }, notificationRouting: { releasePending: async () => {}, claim: async () => true }, eventMatchesRoutine, routineConditionMatches: async () => true, deliversToAutopilot, routineEventKey: () => 'synthetic-key', runRoutine: async (routine) => { runs.push(routine.id); return { status: 'succeeded' }; }, log: async () => {} };
  runInNewContext(source.slice(start, end) + '; globalThis.dispatch = dispatchRoutineEvent;', context);
  await context.dispatch({ id: 'synthetic-event', type: 'vk_event', kind: 'process.completed', autopilot: true });
  assert.deepEqual(runs, [ordinary.id]);
  await context.dispatch({ id: 'synthetic-recovery', type: 'vk_event', kind: 'process.completed' }, autopilot);
  assert.deepEqual(runs, [ordinary.id, autopilot.id]);
 });

 test('an older remote server is revoked before any raw notification can be claimed', async () => {
  const f = fixture();
  f.setProtocol(1);
  await assert.rejects(f.routing.register(routine, ['cloud.notification'], true), /protocol 2/);
  assert.equal(f.calls.at(-1).payload.revoke, true);
  assert.equal(await f.routing.claim(routine, f.event()), false);
 });

 test('an unprepared claim uses a fresh run key while preserving revision and cursor', async () => {
  const row = { id: 'synthetic-alert', revision: 1, claim_token: 'synthetic-token', type: 'workspace_task_completed', cursor: 17, at: '2026-01-01T00:00:00Z' };
  const events = [];
  for (const instance of ['synthetic-before', 'synthetic-after']) {
    const f = fixture(instance);
    await f.routing.register(routine, [], true);
    f.setRecovered([row]);
    events.push((await f.routing.recover(routine))[0]);
  }
  assert.notEqual(events[0].id, events[1].id);
  assert.equal(events[1].notificationRevision, events[0].notificationRevision);
  assert.equal(events[1].cursor, 17);
  assert.equal(events[1].at, row.at);
 });

test('raw follow-ups use durable admission while ordinary follow-ups keep their original behavior', async () => {
  const f = fixture();
  await f.routing.register(routine, [], true);
  const event = f.event();
  await f.routing.claim(routine, event);
  const delivery = { path: '/api/sessions/synthetic-session/follow-up', payload: { prompt: 'Synthetic prompt', executor_config: { executor: 'CODEX' } }, meta: { idempotencyKey: 'synthetic-follow-up' } };
  await f.routing.deliver(routine, event, delivery);
  const staged = f.calls.find((call) => call.path.endsWith('/notification-handoff'));
  assert.equal(staged.path, '/api/sessions/synthetic-session/queue/notification-handoff');
  assert.deepEqual(staged.payload.handoff.payload, { message: 'Synthetic prompt', executor_config: { executor: 'CODEX' } });
  f.calls.length = 0;
  await f.routing.deliver(routine, {}, delivery);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, delivery.path);
  assert.deepEqual(f.calls[0].payload, delivery.payload);
});
