import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createArtifactChannels,
  validateArtifactSchema,
} from "./artifact-channels.mjs";

const empty = { type: "object", properties: {} };
const dataSchema = {
  type: "object",
  properties: { count: { type: "number", minimum: 0 } },
  required: ["count"],
};
const scope = {
  owner_id: "synthetic-owner",
  owner_host: "synthetic-host",
  workspace_id: "synthetic-workspace",
  session_id: "synthetic-session",
};
async function setup(runRule = async () => ({ status: "completed" })) {
  const state = {
    enabled: true,
    rules: [
      { id: "refresh-rule", enabled: true, script: "synthetic" },
      { id: "publisher", enabled: true, script: "synthetic" },
    ],
  };
  let saved;
  let failed = false;
  let beforeSave;
  let calls = 0;
  const persist = async () => {
    await beforeSave?.();
    if (failed) throw new Error("disk unavailable");
    saved = structuredClone(state);
  };
  const execute = async (...args) => {
    calls++;
    return runRule(...args);
  };
  const channels = createArtifactChannels({ state, persist, runRule: execute });
  const config = {
    id: "review-dashboard",
    scope,
    sensitive: false,
    enabled: true,
    data_schema: dataSchema,
    publishers: ["publisher", "refresh-rule"],
    actions: {
      refresh: { label: "Refresh", rule_id: "refresh-rule", schema: empty },
    },
  };
  await channels.configure(config);
  const binding = await channels.describe(config.id, scope);
  const request = {
    scope,
    version: binding.version,
    binding_id: randomUUID(),
    request_id: randomUUID(),
    action: "refresh",
    data: {},
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  return {
    channels,
    state,
    persist,
    execute,
    config,
    binding,
    request,
    calls: () => calls,
    saved: () => saved,
    beforeSave: (callback) => {
      beforeSave = callback;
    },
    fail: () => {
      failed = true;
    },
  };
}

test("published data updates in place and only the registered publisher and schema are accepted", async () => {
  const t = await setup();
  await t.channels.publish("publisher", t.config.id, { count: 3 });
  await t.channels.publish("publisher", t.config.id, { count: 4 });
  const snapshot = await t.channels.snapshot(
    t.config.id,
    scope,
    t.binding.version,
    t.request.binding_id,
  );
  assert.deepEqual(snapshot.data, { count: 4 });
  assert.equal(snapshot.revision, 2);
  assert.equal(t.calls(), 0);
  await assert.rejects(
    t.channels.publish("another-rule", t.config.id, { count: 1 }),
    /publisher/,
  );
  await assert.rejects(
    t.channels.publish("publisher", t.config.id, {
      count: 1,
      secret: "synthetic",
    }),
    /fields/,
  );
});

test("every scope field, version, expiry and unregistered action is rejected before dispatch", async () => {
  const t = await setup();
  for (const key of Object.keys(scope)) {
    await assert.rejects(
      t.channels.request(t.config.id, {
        ...t.request,
        scope: { ...scope, [key]: "wrong" },
      }),
      /scope/,
    );
  }
  for (const patch of [
    { version: "wrong" },
    { action: "other" },
    { request_id: "invalid" },
    { expires_at: "2000-01-01T00:00:00Z" },
    { data: { url: "https://example.invalid" } },
  ]) {
    await assert.rejects(
      t.channels.request(t.config.id, { ...t.request, ...patch }),
    );
  }
  assert.equal(t.calls(), 0);
});

test("concurrent retries and different request IDs cannot dispatch twice while busy", async () => {
  let release;
  const t = await setup(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = t.channels.request(t.config.id, t.request);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await t.channels.request(t.config.id, t.request)).status,
    "processing",
  );
  await assert.rejects(
    t.channels.request(t.config.id, { ...t.request, request_id: randomUUID() }),
    /still running/,
  );
  release({ status: "completed" });
  assert.equal((await first).status, "completed");
  assert.equal(
    (await t.channels.request(t.config.id, t.request)).status,
    "completed",
  );
  assert.equal(t.calls(), 1);
  const restarted = createArtifactChannels({
    state: t.saved(),
    persist: async () => {},
    runRule: () => assert.fail("replayed"),
  });
  assert.equal(
    (await restarted.request(t.config.id, t.request)).status,
    "completed",
  );
});

test("an interrupted or failed operation remains unknown and never retries automatically", async () => {
  const t = await setup(async () => {
    throw new Error("unknown external outcome");
  });
  assert.equal(
    (await t.channels.request(t.config.id, t.request)).status,
    "unknown",
  );
  assert.equal(
    (await t.channels.request(t.config.id, t.request)).status,
    "unknown",
  );
  assert.equal(t.calls(), 1);
  const saved = t.saved();
  saved.artifactRequests[t.request.request_id].status = "processing";
  const restarted = createArtifactChannels({
    state: saved,
    persist: async () => {},
    runRule: () => assert.fail("replayed"),
  });
  assert.equal(
    (await restarted.request(t.config.id, t.request)).status,
    "unknown",
  );
  await assert.rejects(
    restarted.request(t.config.id, { ...t.request, request_id: randomUUID() }),
    /still running/,
  );
  await restarted.complete(
    "publisher",
    t.config.id,
    t.request.request_id,
    "completed",
  );
  assert.equal(
    (
      await restarted.snapshot(
        t.config.id,
        scope,
        t.binding.version,
        t.request.binding_id,
      )
    ).request.status,
    "completed",
  );
  await t.channels.complete(
    "publisher",
    t.config.id,
    t.request.request_id,
    "failed",
  );
  await t.channels.request(t.config.id, {
    ...t.request,
    request_id: randomUUID(),
  });
  assert.equal(t.calls(), 2);
});

test("request claim must be durable before rule execution", async () => {
  const t = await setup();
  t.fail();
  await assert.rejects(t.channels.request(t.config.id, t.request), /disk/);
  assert.equal(t.calls(), 0);
  assert.equal(
    (await t.channels.request(t.config.id, t.request)).status,
    "unknown",
  );
});

test("a rule edit during claim persistence cannot change the validated action", async () => {
  let executed;
  const t = await setup(async (rule) => {
    executed = rule;
    return { status: "completed" };
  });
  const original = structuredClone(t.state.rules[0]);
  t.beforeSave(() => {
    t.state.rules[0].script = "replacement";
    t.state.rules[0].enabled = false;
  });
  assert.equal(
    (await t.channels.request(t.config.id, t.request)).status,
    "completed",
  );
  assert.deepEqual(executed, original);
  assert.equal(t.calls(), 1);
  await assert.rejects(t.channels.describe(t.config.id, scope), /Enabled/);
});

test("acceptance is separate from completion; a registered publisher can finish the request", async () => {
  const t = await setup(async () => ({ status: "accepted" }));
  assert.equal(
    (await t.channels.request(t.config.id, t.request)).status,
    "accepted",
  );
  await assert.rejects(
    t.channels.complete(
      "another-rule",
      t.config.id,
      t.request.request_id,
      "completed",
    ),
    /publisher/,
  );
  await t.channels.complete(
    "publisher",
    t.config.id,
    t.request.request_id,
    "completed",
  );
  assert.equal(
    (
      await t.channels.snapshot(
        t.config.id,
        scope,
        t.binding.version,
        t.request.binding_id,
      )
    ).request.status,
    "completed",
  );
  await t.channels.request(t.config.id, {
    ...t.request,
    request_id: randomUUID(),
  });
  assert.equal(t.calls(), 2);
});

test("changed scripts invalidate bindings and same IDs cannot cross channels or payloads", async () => {
  const t = await setup();
  await t.channels.request(t.config.id, t.request);
  await assert.rejects(
    t.channels.request(t.config.id, { ...t.request, binding_id: randomUUID() }),
    /different data/,
  );
  await assert.rejects(
    () =>
      t.channels.snapshot(
        t.config.id,
        scope,
        t.binding.version,
        randomUUID(),
        t.request.request_id,
      ),
    /scope/,
  );
  t.state.rules[0].script = "changed";
  await assert.rejects(t.channels.request(t.config.id, t.request), /changed/);
  assert.equal(t.calls(), 1);
});

test("disabled channels and publisher write failures do not expose new data", async () => {
  const t = await setup();
  await t.channels.publish("publisher", t.config.id, { count: 1 });
  t.fail();
  await assert.rejects(
    t.channels.publish("publisher", t.config.id, { count: 2 }),
    /disk/,
  );
  assert.equal(
    (
      await t.channels.snapshot(
        t.config.id,
        scope,
        t.binding.version,
        t.request.binding_id,
      )
    ).data.count,
    1,
  );
  t.state.enabled = false;
  await assert.rejects(t.channels.describe(t.config.id, scope), /disabled/);
});

test("schema rejects secrets, unsupported keywords, bad scalar types and excessive payloads", () => {
  for (const schema of [
    { type: "object", properties: { password: { type: "string" } } },
    { type: "string", pattern: ".*" },
    { type: "array", items: empty, maxItems: 201 },
  ]) {
    assert.throws(() => validateArtifactSchema(schema, undefined, 0, true));
  }
  assert.throws(() => validateArtifactSchema(dataSchema, { count: "3" }));
  assert.throws(
    () =>
      validateArtifactSchema(
        { type: "array", items: { type: "string", maxLength: 16000 } },
        ["x".repeat(16000), "x".repeat(16000), "x".repeat(16000)],
      ),
    /large/,
  );
  validateArtifactSchema(
    {
      type: "object",
      properties: { 선택: { type: "array", items: { type: "string" } } },
    },
    { 선택: ["한글"] },
  );
});

test("channel scope cannot be reassigned and malformed actions cannot be configured", async () => {
  const t = await setup();
  await assert.rejects(
    t.channels.configure({
      ...t.config,
      scope: { ...scope, owner_id: "other-owner" },
    }),
    /immutable/,
  );
  for (const actions of [[], "invalid", { refresh: null }]) {
    await assert.rejects(t.channels.configure({ ...t.config, actions }));
  }
  assert.deepEqual(await t.channels.describe(t.config.id, scope), t.binding);
});

test("a failed completion write does not report a durable completion", async () => {
  const t = await setup(async () => ({ status: "accepted" }));
  await t.channels.request(t.config.id, t.request);
  t.fail();
  await assert.rejects(
    t.channels.complete(
      "publisher",
      t.config.id,
      t.request.request_id,
      "completed",
    ),
    /disk/,
  );
  assert.equal(
    (
      await t.channels.snapshot(
        t.config.id,
        scope,
        t.binding.version,
        t.request.binding_id,
      )
    ).request.status,
    "accepted",
  );
  assert.equal(t.calls(), 1);
});

for (const operation of ["publish", "complete"]) {
  test(`reads wait for ${operation} persistence and see rollback on failure`, async () => {
    const t = await setup(async () => ({ status: "accepted" }));
    await t.channels.request(t.config.id, t.request);
    await t.channels.publish("publisher", t.config.id, { count: 1 });
    let rejectSave;
    let entered;
    const saving = new Promise((resolve) => {
      entered = resolve;
    });
    t.beforeSave(() => {
      entered();
      return new Promise((_, reject) => {
        rejectSave = reject;
      });
    });
    const write =
      operation === "publish"
        ? t.channels.publish("publisher", t.config.id, { count: 2 })
        : t.channels.complete(
            "publisher",
            t.config.id,
            t.request.request_id,
            "completed",
          );
    await saving;
    let visible = false;
    const read = t.channels
      .snapshot(t.config.id, scope, t.binding.version, t.request.binding_id)
      .then((snapshot) => {
        visible = true;
        return snapshot;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(visible, false);
    const failed = assert.rejects(write, /disk/);
    rejectSave(new Error("disk unavailable"));
    await failed;
    const snapshot = await read;
    assert.equal(snapshot.data.count, 1);
    assert.equal(snapshot.request.status, "accepted");
    snapshot.data.count = 99;
    assert.equal(
      (
        await t.channels.snapshot(
          t.config.id,
          scope,
          t.binding.version,
          t.request.binding_id,
        )
      ).data.count,
      1,
    );
  });
}

test("channel deletion frees capacity without reviving old bindings", async () => {
  const t = await setup();
  for (let n = 1; n < 128; n++) {
    await t.channels.configure({
      ...t.config,
      id: `channel-${n}`,
      scope: { ...scope, session_id: `session-${n}` },
    });
  }
  await assert.rejects(
    t.channels.configure({ ...t.config, id: "channel-128" }),
    /Too many/,
  );
  await t.channels.remove(t.config.id);
  await t.channels.configure(t.config);
  const renewed = await t.channels.describe(t.config.id, scope);
  assert.notEqual(renewed.version, t.binding.version);
  await assert.rejects(t.channels.request(t.config.id, t.request), /changed/);
  await t.channels.remove("channel-1");
  await t.channels.configure({ ...t.config, id: "channel-128" });
  assert.equal(Object.keys(t.state.artifactChannels).length, 128);
});

test("channel deletion refuses every unresolved state and rolls back failed writes", async () => {
  const t = await setup(async () => ({ status: "accepted" }));
  await t.channels.request(t.config.id, t.request);
  for (const status of ["processing", "accepted", "unknown"]) {
    t.state.artifactRequests[t.request.request_id].status = status;
    await assert.rejects(t.channels.remove(t.config.id), /unfinished/);
  }
  await t.channels.complete(
    "publisher",
    t.config.id,
    t.request.request_id,
    "cancelled",
  );
  t.fail();
  await assert.rejects(t.channels.remove(t.config.id), /disk/);
  assert.deepEqual(await t.channels.describe(t.config.id, scope), t.binding);
});
