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

test("archive removes data and receipts, keeps Rules, and cannot revive old bindings", async () => {
  const t = await setup();
  await t.channels.publish("publisher", t.config.id, { count: 3 });
  await t.channels.request(t.config.id, t.request);
  const rules = structuredClone(t.state.rules);
  const ended = {
    hostId: scope.owner_host,
    workspaceId: scope.workspace_id,
    epoch: 1,
    deleted: false,
  };
  await t.channels.cleanupScope(ended);
  assert.deepEqual(t.state.artifactChannels, {});
  assert.deepEqual(t.state.artifactRequests, {});
  assert.deepEqual(t.state.rules, rules);
  await t.channels.publish("publisher", t.config.id, { count: 9 });
  await t.channels.complete(
    "publisher",
    t.config.id,
    t.request.request_id,
    "completed",
  );
  assert.deepEqual(t.state.artifactChannels, {});
  await assert.rejects(t.channels.request(t.config.id, t.request), /Unknown/);
  await assert.rejects(t.channels.configure(t.config), /scope ended/);
  await t.channels.configure({ ...t.config, workspace_epoch: 1 });
  const fresh = await t.channels.describe(t.config.id, scope, 1);
  assert.notEqual(fresh.version, t.binding.version);
  await t.channels.cleanupScope(ended);
  assert.deepEqual(await t.channels.describe(t.config.id, scope, 1), fresh);
  await assert.rejects(
    t.channels.describe(t.config.id, scope, 0),
    /scope ended/,
  );
  const restored = createArtifactChannels({
    state: structuredClone(t.saved()),
    persist: async () => {},
    runRule: t.execute,
  });
  await assert.rejects(restored.configure(t.config), /scope ended/);
});

test("cleanup rolls back failed persistence and an explicit retry safely finishes it", async () => {
  const t = await setup(async () => ({ status: "accepted" }));
  await t.channels.request(t.config.id, t.request);
  t.beforeSave(() => {
    throw new Error("disk unavailable");
  });
  await assert.rejects(
    t.channels.cleanupScope({
      hostId: scope.owner_host,
      workspaceId: scope.workspace_id,
      epoch: 1,
      deleted: false,
    }),
    /disk/,
  );
  t.beforeSave(undefined);
  assert.deepEqual(await t.channels.describe(t.config.id, scope), t.binding);
  assert.equal(
    t.state.artifactRequests[t.request.request_id].retired,
    undefined,
  );
  assert.deepEqual(t.state.artifactScopeEpochs, {});
  await t.channels.cleanupScope({
    hostId: scope.owner_host,
    workspaceId: scope.workspace_id,
    epoch: 1,
    deleted: false,
  });
  const record = t.state.artifactRequests[t.request.request_id];
  assert.equal(record.status, "accepted");
  assert.equal(record.retired, true);
  await assert.rejects(
    t.channels.complete(
      "wrong-rule",
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
  assert.deepEqual(t.state.artifactRequests, {});
});

test("an in-flight action cannot repopulate a retired or newly configured dashboard", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const t = await setup(async () => {
    entered();
    await gate;
    return { status: "completed" };
  });
  const running = t.channels.request(t.config.id, t.request);
  await started;
  await t.channels.cleanupScope({
    hostId: scope.owner_host,
    workspaceId: scope.workspace_id,
    epoch: 1,
    deleted: false,
  });
  assert.equal(
    t.state.artifactRequests[t.request.request_id].status,
    "processing",
  );
  await t.channels.configure({ ...t.config, workspace_epoch: 1 });
  await t.channels.publish(
    "publisher",
    t.config.id,
    { count: 99 },
    t.request.request_id,
  );
  const fresh = await t.channels.describe(t.config.id, scope, 1);
  assert.equal(
    (await t.channels.snapshot(t.config.id, scope, fresh.version, randomUUID()))
      .data,
    null,
  );
  release();
  assert.equal((await running).status, "completed");
  assert.deepEqual(t.state.artifactRequests, {});
  assert.equal(t.state.artifactChannels[t.config.id].data, null);
});

test("session and workspace deletion preserve unrelated scopes and reject delayed configuration", async () => {
  const t = await setup();
  const other = {
    ...t.config,
    id: "other-dashboard",
    scope: { ...scope, session_id: "synthetic-other-session" },
  };
  await t.channels.configure(other);
  await t.channels.cleanupScope({
    hostId: scope.owner_host,
    workspaceId: scope.workspace_id,
    sessionId: scope.session_id,
    deleted: true,
  });
  await assert.rejects(t.channels.configure(t.config), /scope ended/);
  assert.ok(await t.channels.describe(other.id, other.scope));
  await t.channels.cleanupScope({
    hostId: scope.owner_host,
    workspaceId: scope.workspace_id,
    epoch: 2,
    deleted: true,
  });
  await assert.rejects(
    t.channels.configure({ ...other, workspace_epoch: 3 }),
    /scope ended/,
  );
  assert.deepEqual(t.state.artifactChannels, {});
});

test("a new channel generation rejects late writes before its delayed cleanup event arrives", async () => {
  const t = await setup(async () => ({ status: "accepted" }));
  await t.channels.request(t.config.id, t.request);
  await t.channels.configure({ ...t.config, workspace_epoch: 1 });
  await t.channels.publish(
    "publisher",
    t.config.id,
    { count: 99 },
    t.request.request_id,
  );
  assert.equal(t.state.artifactChannels[t.config.id].data, null);
  await t.channels.cleanupScope({
    hostId: scope.owner_host,
    workspaceId: scope.workspace_id,
    epoch: 1,
    deleted: false,
  });
  assert.equal(t.state.artifactChannels[t.config.id].workspace_epoch, 1);
  assert.equal(t.state.artifactRequests[t.request.request_id].retired, true);
  await t.channels.remove(t.config.id);
  await t.channels.complete(
    "publisher",
    t.config.id,
    t.request.request_id,
    "failed",
  );
  assert.deepEqual(t.state.artifactRequests, {});
});

test("cleanup cannot cross hosts even when workspace and session identifiers match", async () => {
  const t = await setup();
  for (const input of [
    null,
    [],
    {},
    { workspaceId: scope.workspace_id, epoch: 1, deleted: false },
  ]) {
    await assert.rejects(t.channels.cleanupScope(input), /lifecycle/);
  }
  const other = {
    ...t.config,
    id: "other-host-dashboard",
    scope: { ...scope, owner_host: "synthetic-other-host" },
  };
  await t.channels.configure(other);
  await assert.rejects(
    t.channels.cleanupScope({
      workspaceId: scope.workspace_id,
      epoch: 1,
      deleted: false,
    }),
    /lifecycle/,
  );
  await t.channels.cleanupScope({
    hostId: scope.owner_host,
    workspaceId: scope.workspace_id,
    epoch: 1,
    deleted: true,
  });
  assert.deepEqual(Object.keys(t.state.artifactChannels), [other.id]);
  await t.channels.configure(other);
});

test("Drawer dashboards survive workspace cleanup, pause, resume and delete by ordered revision", async () => {
  const t = await setup();
  const artifact = randomUUID();
  const drawer = {
    kind: "drawer",
    owner_id: "synthetic-owner",
    owner_host: scope.owner_host,
    note_id: randomUUID(),
    artifact_id: artifact,
  };
  const config = {
    ...t.config,
    id: "drawer-dashboard",
    scope: drawer,
    actions: {},
  };
  await t.channels.configure(config);
  const binding = await t.channels.describe(config.id, drawer);
  await t.channels.publish("publisher", config.id, { count: 5 });
  await t.channels.cleanupScope({
    hostId: scope.owner_host,
    workspaceId: scope.workspace_id,
    epoch: 1,
    deleted: true,
  });
  assert.equal(
    (await t.channels.snapshot(config.id, drawer, binding.version, artifact))
      .data.count,
    5,
  );
  await assert.rejects(
    t.channels.snapshot(
      config.id,
      { ...drawer, note_id: randomUUID() },
      binding.version,
      artifact,
    ),
    /scope/,
  );
  await assert.rejects(
    t.channels.request(config.id, { ...t.request, scope: drawer }),
    /read-only/,
  );
  await assert.rejects(
    t.channels.configure({ ...config, actions: t.config.actions }),
    /read-only/,
  );
  const event = {
    type: "drawer_artifact_lifecycle",
    hostId: drawer.owner_host,
    artifactId: artifact,
    revision: 2,
    paused: true,
    deleted: false,
  };
  await t.channels.cleanupScope(event);
  await assert.rejects(
    t.channels.snapshot(config.id, drawer, binding.version, artifact),
    /archived/,
  );
  await t.channels.publish("publisher", config.id, { count: 99 });
  assert.equal(t.state.artifactChannels[config.id].data.count, 5);
  await t.channels.cleanupScope({ ...event, revision: 3, paused: false });
  await t.channels.cleanupScope(event);
  assert.equal(
    (await t.channels.snapshot(config.id, drawer, binding.version, artifact))
      .data.count,
    5,
  );
  await t.channels.publish("publisher", config.id, { count: 6 });
  await t.channels.cleanupScope({
    ...event,
    revision: 4,
    paused: false,
    deleted: true,
  });
  await t.channels.cleanupScope({ ...event, revision: 5, paused: false });
  assert.equal(t.state.artifactChannels[config.id], undefined);
  await assert.rejects(t.channels.configure(config), /scope ended/);
  await t.channels.publish("publisher", config.id, { count: 7 });
  assert.ok(t.state.rules.find((rule) => rule.id === "publisher").enabled);
  const restored = createArtifactChannels({
    state: structuredClone(t.saved()),
    persist: async () => {},
    runRule: t.execute,
  });
  await assert.rejects(restored.configure(config), /scope ended/);
});

test("Drawer move preserves data and publishers, fences old bindings and retries after restart", async () => {
  const t = await setup();
  const drawer = { kind: "drawer", owner_id: scope.owner_id,
    owner_host: scope.owner_host, note_id: randomUUID(), artifact_id: randomUUID() };
  const config = { ...t.config, id: "moving-dashboard", scope: drawer, actions: {} };
  await t.channels.configure(config);
  await t.channels.publish("publisher", config.id, { count: 7 });
  const binding = await t.channels.describe(config.id, drawer);
  const original = structuredClone(t.state.artifactChannels[config.id]);
  const move = { scope: drawer, target_note_id: randomUUID(),
    operation_id: randomUUID(), version: binding.version };
  for (const key of ["owner_id", "owner_host", "artifact_id", "note_id"]) {
    await assert.rejects(t.channels.moveDrawer(config.id,
      { ...move, scope: { ...drawer, [key]: randomUUID() } }), /scope/);
  }
  await assert.rejects(t.channels.moveDrawer(config.id,
    { ...move, version: "stale" }), /changed/);
  const moved = await t.channels.moveDrawer(config.id, move);
  assert.notEqual(moved.version, binding.version);
  const after = t.state.artifactChannels[config.id];
  assert.deepEqual({ ...after, scope: original.scope, drawer_move: undefined },
    { ...original, drawer_move: undefined });
  assert.deepEqual(t.saved().artifactChannels[config.id], after);
  const restarted = createArtifactChannels({ state: structuredClone(t.saved()),
    persist: async () => {}, runRule: t.execute });
  assert.deepEqual(await restarted.moveDrawer(config.id, move), moved);
  assert.deepEqual(await restarted.moveDrawer(config.id, {
    ...move, scope: Object.fromEntries(Object.entries(drawer).reverse()),
  }), moved);
  await assert.rejects(restarted.moveDrawer(config.id,
    { ...move, target_note_id: randomUUID() }), /Conflicting/);
  await assert.rejects(restarted.describe(config.id, drawer), /scope/);
  const destination = { ...drawer, note_id: move.target_note_id };
  await assert.rejects(restarted.snapshot(config.id, destination,
    binding.version, drawer.artifact_id), /changed/);
  await restarted.publish("publisher", config.id, { count: 8 });
  const snapshot = await restarted.snapshot(config.id, destination,
    moved.version, drawer.artifact_id);
  assert.deepEqual(snapshot.data, { count: 8 });
  assert.equal(snapshot.revision, original.revision + 1);
  const returned = await restarted.moveDrawer(config.id, {
    scope: destination, target_note_id: drawer.note_id,
    operation_id: randomUUID(), version: moved.version,
  });
  assert.notEqual(returned.version, binding.version);
  await assert.rejects(restarted.moveDrawer(config.id, move), /changed/);
  assert.equal(t.calls(), 0);
});

test("Drawer move rolls back scope when persistence fails", async () => {
  const t = await setup();
  const drawer = { kind: "drawer", owner_id: scope.owner_id,
    owner_host: scope.owner_host, note_id: randomUUID(), artifact_id: randomUUID() };
  const config = { ...t.config, id: "moving-dashboard", scope: drawer, actions: {} };
  await t.channels.configure(config);
  const binding = await t.channels.describe(config.id, drawer);
  const before = structuredClone(t.state.artifactChannels[config.id]);
  t.fail();
  await assert.rejects(t.channels.moveDrawer(config.id, { scope: drawer,
    version: binding.version, target_note_id: randomUUID(), operation_id: randomUUID() }), /disk/);
  assert.deepEqual({ ...t.state.artifactChannels[config.id], drawer_move: undefined },
    { ...before, drawer_move: undefined });
  assert.deepEqual(await t.channels.describe(config.id, drawer), binding);
});

test("legacy Drawer move receipts remain retryable after upgrading the transfer format", async () => {
  const t = await setup();
  const drawer = {
    kind: "drawer", owner_id: scope.owner_id, owner_host: scope.owner_host,
    note_id: randomUUID(), artifact_id: randomUUID(),
  };
  const config = { ...t.config, id: "legacy-transfer", scope: drawer, actions: {} };
  await t.channels.configure(config);
  await t.channels.publish("publisher", config.id, { count: 8 });
  const binding = await t.channels.describe(config.id, drawer);
  const move = { scope: drawer, target_note_id: randomUUID(),
    operation_id: randomUUID(), version: binding.version };
  const moved = await t.channels.moveDrawer(config.id, move);
  t.state.artifactChannels[config.id].drawer_move = structuredClone(move);
  const restarted = createArtifactChannels({ state: t.state, persist: t.persist, runRule: t.execute });
  assert.deepEqual(await restarted.moveDrawer(config.id, move), moved);
  assert.equal((await restarted.snapshot(config.id,
    { ...drawer, note_id: move.target_note_id }, moved.version)).data.count, 8);
  assert.equal(t.calls(), 0);
});

test("all ownership directions preserve channel history, publishers and the five-minute schedule after source cleanup", async () => {
  const t = await setup();
  const config = { ...t.config, id: "portable-dashboard", actions: {} };
  await t.channels.configure(config);
  t.state.routines = [
    {
      id: "synthetic-periodic",
      enabled: true,
      trigger: { type: "schedule", cron: "*/5 * * * *", timezone: "UTC" },
      action: {
        type: "run_rule",
        connectorId: "synthetic-connector",
        targetHostId: scope.owner_host,
        input: { ruleId: "publisher" },
      },
    },
  ];
  const routines = structuredClone(t.state.routines);
  const rules = structuredClone(t.state.rules);
  const artifact = randomUUID();
  let current = scope;
  let binding = await t.channels.describe(config.id, current);
  const generation = t.state.artifactChannels[config.id].generation;
  const historyId = randomUUID();
  t.state.artifactRequests[historyId] = {
    request_id: historyId,
    channel_id: config.id,
    binding_id: randomUUID(),
    status: "completed",
    scope,
    generation,
    workspace_epoch: 0,
  };
  await t.channels.publish("publisher", config.id, { count: 5 });
  const destinations = [
    {
      kind: "drawer",
      owner_id: scope.owner_id,
      owner_host: scope.owner_host,
      artifact_id: artifact,
      note_id: randomUUID(),
    },
    {
      kind: "workspace_artifact",
      owner_id: scope.owner_id,
      owner_host: scope.owner_host,
      artifact_id: artifact,
      workspace_id: randomUUID(),
      session_id: randomUUID(),
    },
    {
      kind: "workspace_artifact",
      owner_id: scope.owner_id,
      owner_host: scope.owner_host,
      artifact_id: artifact,
      workspace_id: randomUUID(),
      session_id: randomUUID(),
    },
    {
      kind: "drawer",
      owner_id: scope.owner_id,
      owner_host: scope.owner_host,
      artifact_id: artifact,
      note_id: randomUUID(),
    },
    {
      kind: "drawer",
      owner_id: scope.owner_id,
      owner_host: scope.owner_host,
      artifact_id: artifact,
      note_id: randomUUID(),
    },
  ];
  let lifecycleRevision = 0;
  for (const target of destinations) {
    const input = {
      scope: current,
      target_scope: target,
      version: binding.version,
      operation_id: randomUUID(),
    };
    const snapshot = await t.channels.snapshot(
      config.id,
      current,
      binding.version,
      artifact,
    );
    const next = await t.channels.transfer(config.id, input);
    assert.deepEqual(await t.channels.transfer(config.id, input), next);
    assert.deepEqual(
      await t.channels.snapshot(config.id, target, next.version, artifact),
      snapshot,
    );
    await assert.rejects(t.channels.describe(config.id, current), /scope/);
    await t.channels.cleanupScope({
      hostId: scope.owner_host,
      workspaceId: current.workspace_id ?? "synthetic-old-workspace",
      epoch: 10,
      deleted: true,
    });
    assert.ok(t.state.artifactRequests[historyId]);
    if (target.kind === "workspace_artifact") {
      await t.channels.cleanupScope({
        type: "drawer_artifact_lifecycle",
        hostId: scope.owner_host,
        artifactId: artifact,
        revision: ++lifecycleRevision,
        paused: true,
        deleted: false,
      });
      await t.channels.publish("publisher", config.id, { count: 999 });
      await assert.rejects(
        t.channels.snapshot(config.id, target, next.version, artifact),
        /archived/,
      );
      await t.channels.cleanupScope({
        type: "drawer_artifact_lifecycle",
        hostId: scope.owner_host,
        artifactId: artifact,
        revision: ++lifecycleRevision,
        paused: false,
        deleted: false,
      });
      assert.deepEqual(
        (await t.channels.snapshot(config.id, target, next.version, artifact))
          .data,
        snapshot.data,
      );
    }
    await t.channels.publish("publisher", config.id, {
      count: snapshot.data.count + 1,
    });
    assert.equal(t.state.artifactChannels[config.id].generation, generation);
    assert.deepEqual(
      t.state.artifactChannels[config.id].publishers,
      config.publishers,
    );
    assert.deepEqual(t.state.routines, routines);
    assert.deepEqual(t.state.rules, rules);
    current = target;
    binding = next;
  }
  assert.deepEqual(
    (await t.channels.snapshot(config.id, current, binding.version, artifact))
      .data,
    { count: 10 },
  );
});

test("transfers reject foreign owners, interactive channels and unresolved actions before changing state", async () => {
  const t = await setup();
  const target = {
    kind: "drawer",
    owner_id: scope.owner_id,
    owner_host: scope.owner_host,
    artifact_id: randomUUID(),
    note_id: randomUUID(),
  };
  const input = {
    scope,
    target_scope: target,
    version: t.binding.version,
    operation_id: randomUUID(),
  };
  for (const key of ["owner_id", "owner_host"])
    await assert.rejects(
      t.channels.transfer(t.config.id, {
        ...input,
        target_scope: { ...target, [key]: "foreign" },
      }),
      /scope/,
    );
  await assert.rejects(t.channels.transfer(t.config.id, input), /read-only/);
  await t.channels.configure({ ...t.config, actions: {} });
  const binding = await t.channels.describe(t.config.id, scope);
  t.state.artifactRequests.synthetic = {
    channel_id: t.config.id,
    status: "unknown",
  };
  assert.equal(
    (await t.channels.inspect(t.config.id, scope)).transferable,
    false,
  );
  await assert.rejects(
    t.channels.transfer(t.config.id, { ...input, version: binding.version }),
    /unfinished/,
  );
  assert.deepEqual(t.state.artifactChannels[t.config.id].scope, scope);
});

test("a pending transfer survives old workspace cleanup while unrelated channels are revoked", async () => {
  const t = await setup();
  const config = { ...t.config, id: "retained-dashboard", actions: {} };
  await t.channels.configure(config);
  await t.channels.publish("publisher", config.id, { count: 12 });
  const binding = await t.channels.describe(config.id, scope);
  await t.channels.cleanupScope({
    hostId: scope.owner_host,
    workspaceId: scope.workspace_id,
    epoch: 1,
    deleted: true,
    preserve_channels: [config.id],
  });
  await assert.rejects(t.channels.describe(t.config.id, scope), /Unknown/);
  const target = {
    kind: "drawer",
    owner_id: scope.owner_id,
    owner_host: scope.owner_host,
    artifact_id: randomUUID(),
    note_id: randomUUID(),
  };
  const moved = await t.channels.transfer(config.id, {
    scope,
    version: binding.version,
    target_scope: target,
    operation_id: randomUUID(),
  });
  await t.channels.cleanupScope({
    hostId: scope.owner_host,
    workspaceId: scope.workspace_id,
    sessionId: scope.session_id,
    deleted: true,
  });
  assert.deepEqual(
    (
      await t.channels.snapshot(
        config.id,
        target,
        moved.version,
        target.artifact_id,
      )
    ).data,
    { count: 12 },
  );
  await t.channels.publish("publisher", config.id, { count: 13 });
  assert.deepEqual(
    (
      await t.channels.snapshot(
        config.id,
        target,
        moved.version,
        target.artifact_id,
      )
    ).data,
    { count: 13 },
  );
});

test("Drawer lifecycle rejects malformed events, isolates hosts and rolls back failed persistence", async () => {
  const t = await setup();
  const artifact = randomUUID();
  const drawer = {
    kind: "drawer",
    owner_id: "synthetic-owner",
    owner_host: scope.owner_host,
    note_id: randomUUID(),
    artifact_id: artifact,
  };
  const config = {
    ...t.config,
    id: "drawer-dashboard",
    scope: drawer,
    actions: {},
  };
  await t.channels.configure(config);
  const event = {
    type: "drawer_artifact_lifecycle",
    hostId: scope.owner_host,
    artifactId: artifact,
    revision: 1,
    paused: false,
    deleted: true,
  };
  for (const patch of [
    { artifactId: "../invalid" },
    { revision: 0 },
    { paused: null },
    { hostId: "" },
  ])
    await assert.rejects(
      t.channels.cleanupScope({ ...event, ...patch }),
      /Invalid/,
    );
  await t.channels.cleanupScope({ ...event, hostId: "other-synthetic-host" });
  assert.ok(await t.channels.describe(config.id, drawer));
  t.beforeSave(() => {
    throw new Error("synthetic disk failure");
  });
  await assert.rejects(t.channels.cleanupScope(event), /disk/);
  t.beforeSave(undefined);
  assert.ok(await t.channels.describe(config.id, drawer));
  await t.channels.cleanupScope(event);
  await assert.rejects(t.channels.describe(config.id, drawer), /Unknown/);
});

test("recovery redirects an uncommitted or committed transfer, survives restart and fences stale recovery requests", async () => {
  for (const committed of [false, true]) {
    const t = await setup();
    const config = { ...t.config, id: "recoverable-channel", actions: {} };
    await t.channels.configure(config);
    await t.channels.publish("publisher", config.id, { count: 17 });
    const binding = await t.channels.describe(config.id, scope);
    const first = {
      kind: "drawer",
      owner_id: scope.owner_id,
      owner_host: scope.owner_host,
      artifact_id: randomUUID(),
      note_id: randomUUID(),
    };
    const original = {
      operation_id: randomUUID(),
      scope,
      version: binding.version,
      target_scope: first,
    };
    let firstVersion;
    if (committed)
      firstVersion = (await t.channels.transfer(config.id, original)).version;
    const next = { ...first, note_id: randomUUID() };
    const recovery = {
      ...original,
      target_scope: next,
      previous_targets: [first],
    };
    const recovered = await t.channels.transfer(config.id, recovery);
    const restarted = createArtifactChannels({
      state: structuredClone(t.saved()),
      persist: async () => {},
      runRule: t.execute,
    });
    assert.deepEqual(await restarted.transfer(config.id, recovery), recovered);
    await assert.rejects(
      restarted.transfer(config.id, original),
      /Conflicting/,
    );
    const back = { ...original, previous_targets: [first, next] };
    const returned = await restarted.transfer(config.id, back);
    if (firstVersion) assert.notEqual(returned.version, firstVersion);
    assert.equal(
      (await restarted.snapshot(config.id, first, returned.version)).data.count,
      17,
    );
    await assert.rejects(
      restarted.transfer(config.id, recovery),
      /Conflicting/,
    );
    await assert.rejects(
      restarted.transfer(config.id, {
        ...back,
        previous_targets: [next, next, next],
      }),
      /Conflicting/,
    );
    assert.deepEqual(t.state.rules, t.saved().rules);
    assert.equal(t.calls(), 0);
  }
});

test("a failed recovery write preserves the last committed owner, binding and data", async () => {
  const t = await setup();
  const config = { ...t.config, id: "recoverable-rollback", actions: {} };
  await t.channels.configure(config);
  await t.channels.publish("publisher", config.id, { count: 19 });
  const binding = await t.channels.describe(config.id, scope);
  const target = {
    kind: "drawer",
    owner_id: scope.owner_id,
    owner_host: scope.owner_host,
    artifact_id: randomUUID(),
    note_id: randomUUID(),
  };
  const move = {
    operation_id: randomUUID(),
    scope,
    version: binding.version,
    target_scope: target,
  };
  const moved = await t.channels.transfer(config.id, move);
  t.fail();
  await assert.rejects(
    t.channels.transfer(config.id, {
      ...move,
      target_scope: { ...target, note_id: randomUUID() },
      previous_targets: [target],
    }),
    /disk/,
  );
  assert.deepEqual(await t.channels.describe(config.id, target), moved);
  assert.equal(
    (await t.channels.snapshot(config.id, target, moved.version)).data.count,
    19,
  );
  assert.deepEqual(await t.channels.transfer(config.id, move), moved);
});
