import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test(
  "real worker connects event publishing, artifact actions and a scoped routine without replay",
  { timeout: 20000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "vibe-artifact-worker-"),
    );
    const scope = {
      owner_id: "fixture-owner",
      owner_host: "fixture-host",
      workspace_id: "fixture-workspace",
      session_id: "fixture-session",
    };
    const token = randomUUID();
    let notifications = 0;
    const host = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/automation-actions/status")
        return res.end(
          JSON.stringify({ hostId: scope.owner_host, busy: false }),
        );
      if (req.url === "/api/automation-actions/notification") {
        notifications++;
        assert.ok(req.headers["idempotency-key"]);
        return res.end(JSON.stringify({ success: true }));
      }
      res.writeHead(404).end("{}");
    });
    host.listen(0, "127.0.0.1");
    await once(host, "listening");
    const baseUrl = `http://127.0.0.1:${host.address().port}`;
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const script = `async function handle(event, ctx) {
    if (event.source === 'fixture') {
      await ctx.artifacts.publish('dashboard', { count: event.count });
      if (event.request_id) await ctx.artifacts.complete('dashboard', event.request_id, 'completed');
    }
    if (event.source === 'artifact') {
      if (event.action === 'start') return ctx.actions.vibe.runRoutine('notify');
      await ctx.artifacts.publish('dashboard', event.data);
      return { status: 'completed' };
    }
  }`;
    await writeFile(
      path.join(directory, "state.json"),
      JSON.stringify({
        enabled: true,
        rules: [{ id: "publisher", enabled: true, kind: "script", script }],
        connectors: [
          {
            id: "vibe",
            type: "vibe_kanban",
            enabled: true,
            config: {
              baseUrl,
              bearerToken: "synthetic-test-token",
              hostBridges: {
                [scope.owner_host]: {
                  baseUrl,
                  projectIds: [],
                  repositoryIds: [],
                },
              },
            },
          },
        ],
        routines: [
          {
            id: "notify",
            enabled: true,
            trigger: { type: "unused" },
            action: {
              type: "notification",
              connectorId: "vibe",
              targetHostId: scope.owner_host,
              input: { title: "Synthetic", message: "Fixture" },
            },
          },
        ],
      }),
    );
    let child;
    const start = async () => {
      child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./server.mjs", import.meta.url))],
        {
          env: {
            ...process.env,
            HOST: "127.0.0.1",
            PORT: String(port),
            ADMIN_TOKEN: token,
            AUTOMATION_DATA_DIR: directory,
          },
          stdio: "pipe",
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const end = Date.now() + 8000;
      while (!output.includes("automation worker listening")) {
        if (child.exitCode !== null || Date.now() > end)
          throw new Error(`Worker startup failed: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const stop = async () => {
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    };
    const call = async (route, body, authenticated = true) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    try {
      await start();
      const schema = {
        type: "object",
        properties: { count: { type: "number", minimum: 0 } },
        required: ["count"],
      };
      const configured = await call("artifact-channels", {
        id: "dashboard",
        sensitive: false,
        enabled: true,
        scope,
        data_schema: schema,
        publishers: ["publisher"],
        actions: {
          refresh: { rule_id: "publisher", label: "Refresh", schema },
          start: {
            rule_id: "publisher",
            label: "Start",
            schema: { type: "object", properties: {} },
          },
        },
      });
      assert.equal(configured.status, 200);
      assert.equal(
        (await call("artifact-channels/dashboard/describe", { scope }, false))
          .status,
        401,
      );
      const { data: binding } = await call(
        "artifact-channels/dashboard/describe",
        { scope },
      );
      const request = {
        scope,
        version: binding.version,
        binding_id: randomUUID(),
        request_id: randomUUID(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        action: "refresh",
        data: { count: 4 },
      };
      assert.equal(
        (
          await call("events", {
            id: randomUUID(),
            source: "fixture",
            type: "count",
            count: 3,
          })
        ).status,
        202,
      );
      assert.equal(
        (await call("artifact-channels/dashboard/snapshot", request)).data.data
          .count,
        3,
      );
      assert.equal(
        (await call("artifact-channels/dashboard/request", request)).data
          .status,
        "completed",
      );
      assert.equal(
        (await call("artifact-channels/dashboard/snapshot", request)).data.data
          .count,
        4,
      );
      const startRequest = {
        ...request,
        request_id: randomUUID(),
        action: "start",
        data: {},
      };
      const started = await call(
        "artifact-channels/dashboard/request",
        startRequest,
      );
      assert.equal(
        started.data.status,
        "accepted",
        JSON.stringify((await call("state")).data.routineRuns),
      );
      assert.equal(notifications, 1);
      await call("artifact-channels/dashboard/request", startRequest);
      assert.equal(notifications, 1);
      await call("events", {
        id: randomUUID(),
        source: "fixture",
        type: "count",
        count: 5,
        request_id: startRequest.request_id,
      });
      assert.equal(
        (await call("artifact-channels/dashboard/snapshot", startRequest)).data
          .request.status,
        "completed",
      );
      await stop();
      await start();
      assert.equal(
        (await call("artifact-channels/dashboard/request", startRequest)).data
          .status,
        "completed",
      );
      assert.equal(notifications, 1);
      const settings = (await call("state")).data;
      assert.equal(settings.artifactRequests, undefined);
      assert.equal(settings.artifactChannels, undefined);
      const saved = JSON.parse(
        await readFile(path.join(directory, "state.json"), "utf8"),
      );
      assert.equal(saved.retryQueue.length, 0);
      assert.equal(saved.artifactChannels.dashboard.data.count, 5);
    } finally {
      await stop();
      await new Promise((resolve) => host.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
