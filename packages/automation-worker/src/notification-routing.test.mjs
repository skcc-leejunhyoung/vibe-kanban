import test from "node:test";
import assert from "node:assert/strict";
import { createNotificationRouting } from "./notification-routing.mjs";

const routine = { id: "test-routine", action: { targetHostId: "test-host" } };
function fixture() {
  const calls = [];
  let recovered = [];
  let receipt = { status: "missing" };
  let failure;
  const api = async (_routine, method, path, payload, host, meta) => {
    calls.push({ method, path, payload, host, meta });
    if (path.startsWith("/v1/notifications/"))
      assert.match(path, /\/(claim|renew-claim|handoff|consume|release)$/);
    if (failure?.(path))
      throw Object.assign(new Error("expired"), { status: 409 });
    if (path === "/v1/autopilot-notification-leases") return { id: "lease" };
    if (path.startsWith("/v1/notification-claims?"))
      return { claims: recovered };
    if (path.includes("/receipts/")) return receipt;
    return { data: { claim_token: "claim" } };
  };
  const routing = createNotificationRouting({ api, instanceId: "instance" });
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

test("batch is frozen atomically before queueing; consume follows acceptance", async () => {
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
    paths.indexOf("/queue") > paths.indexOf("/v1/notifications/a/handoff"),
  );
  assert.ok(
    paths.indexOf("/v1/notifications/a/consume") > paths.indexOf("/queue"),
  );
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
  assert.ok(f.calls.some((c) => c.path.endsWith("/consume")));
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
  const sent = f.calls.find((c) => c.path === "/queue");
  assert.deepEqual(sent.payload, { message: "saved" });
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
