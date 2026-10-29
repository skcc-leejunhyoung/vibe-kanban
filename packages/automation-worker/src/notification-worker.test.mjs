import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test(
  "a stalled Autopilot host cannot block another routine registration",
  { timeout: 10000 },
  async () => {
    const hostId = "00000000-0000-4000-8000-000000000456";
    const directory = await mkdtemp(
      path.join(tmpdir(), "synthetic-notification-worker-"),
    );
    let registered;
    const registration = new Promise((resolve) => {
      registered = resolve;
    });
    const remote = createServer(async (req, res) => {
      if (req.url.startsWith("/stalled/")) return;
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/hosts")
        return res.end(JSON.stringify({ hosts: [{ id: hostId, machine_id: "healthy", access_role: "owner" }] }));
      if (req.url === "/api/automation-actions/status")
        return res.end(
          JSON.stringify({ hostId: "healthy", notificationProtocol: 2 }),
        );
      if (req.url === "/api/workspaces/autopilot")
        return res.end(
          JSON.stringify({ data: { session: { id: "synthetic-session" } } }),
        );
      if (req.url === "/v1/autopilot-notification-leases") {
        let body = "";
        for await (const part of req) body += part;
        registered(JSON.parse(body));
        return res.end(JSON.stringify({ id: "synthetic-lease", protocol: 2 }));
      }
      res.end(JSON.stringify({ claims: [], events: [] }));
    });
    remote.listen(0, "127.0.0.1");
    await once(remote, "listening");
    const baseUrl = `http://127.0.0.1:${remote.address().port}`;
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    await writeFile(
      path.join(directory, "state.json"),
      JSON.stringify({
        enabled: true,
        rules: [],
        connectors: [
          {
            id: "vibe",
            type: "vibe_kanban",
            enabled: true,
            config: {
              baseUrl,
              bearerToken: "synthetic-token",
              hostBridges: {
                stalled: { baseUrl: `${baseUrl}/stalled` },
                healthy: { baseUrl },
              },
            },
          },
          {
            id: "events",
            type: "vibe_events",
            enabled: true,
            config: { vibeConnectorId: "vibe", kinds: ["cloud.notification"] },
          },
        ],
        routines: ["stalled", "healthy"].map((host) => ({
          id: `synthetic-${host}`,
          enabled: true,
          trigger: {
            type: "vk_event",
            connectorId: "events",
            kinds: ["cloud.notification"],
          },
          action: {
            type: "send_prompt",
            connectorId: "vibe",
            targetHostId: host,
            input: { target: "autopilot", queue: true, prompt: "Synthetic" },
          },
        })),
      }),
    );
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./server.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: String(port),
          ADMIN_TOKEN: "synthetic-admin-token",
          AUTOMATION_DATA_DIR: directory,
        },
        stdio: "ignore",
      },
    );
    let deadline;
    try {
      const result = await Promise.race([
        registration,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("healthy lease blocked by stalled host")),
            3000,
          );
        }),
      ]);
      assert.equal(result.host_id, hostId);
      assert.equal(result.revoke, false);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      remote.closeAllConnections();
      await new Promise((resolve) => remote.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a killed worker recovers a lost queue response after its state writes fail",
  { timeout: 25000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "synthetic-notification-restart-"),
    );
    const statePath = path.join(directory, "state.json");
    const hostId = randomUUID();
    const machineId = "npm_user_0000000000000002";
    const sessionId = randomUUID();
    const alertId = randomUUID();
    const leaseId = randomUUID();
    const claimToken = randomUUID();
    const accepted = Promise.withResolvers();
    const persistenceFailed = Promise.withResolvers();
    const consumed = Promise.withResolvers();
    let child;
    let output = "";
    let instance;
    let previousInstance;
    let claimed = false;
    let handoff;
    let handoffKey;
    let queueCalls = 0;
    let consumeCalls = 0;
    let failure;
    const remote = createServer(async (req, res) => {
      try {
        let text = "";
        for await (const part of req) text += part;
        const body = text ? JSON.parse(text) : {};
        const respond = (data) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(data));
        };
        if (req.url === "/v1/hosts")
          return respond({ hosts: [{ id: hostId, machine_id: machineId, access_role: "owner" }] });
        if (req.url === "/api/automation-actions/status")
          return respond({ hostId: machineId, notificationProtocol: 2 });
        if (req.url === "/api/workspaces/autopilot")
          return respond({
            data: {
              session: { id: sessionId },
              executor_config: { executor: "CODEX" },
            },
          });
        if (req.url === "/v1/autopilot-notification-leases") {
          assert.equal(body.host_id, hostId);
          if (!instance) previousInstance = body.instance_id;
          instance = body.instance_id;
          return respond({ id: leaseId, protocol: 2 });
        }
        if (req.url.startsWith("/v1/notification-claims?"))
          return respond({
            claims: consumeCalls
              ? []
              : [
                  {
                    id: alertId,
                    revision: 1,
                    type: "workspace_task_completed",
                    host_id: hostId,
                    state: claimed ? "autopilot_claimed" : "autopilot_pending",
                    claim_token: claimed ? claimToken : null,
                    handoff_key: handoffKey,
                    handoff,
                  },
                ],
          });
        if (req.url.startsWith(`/v1/notifications/${alertId}/`)) {
          assert.equal(body.instance_id, instance);
          assert.equal(body.lease_id, leaseId);
          assert.equal(body.revision, 1);
          const action = req.url.split("/").at(-1);
          if (action === "claim") {
            claimed = true;
            // The worker can still read config, but every subsequent state write fails.
            await rename(statePath, path.join(directory, "state-backup.json"));
            await mkdir(statePath);
          } else {
            assert.equal(body.claim_token, claimToken);
            if (action === "handoff") {
              handoffKey = body.handoff_key;
              handoff = body.handoff;
            } else assert.equal(action, "renew-claim");
          }
          return respond({ data: { claim_token: claimToken }, txid: 1 });
        }
        if (req.url === `/api/sessions/${sessionId}/queue/notification-handoff`) {
          queueCalls++;
          assert.equal(req.headers["idempotency-key"], handoffKey);
          assert.deepEqual(body, { lease_id: leaseId, handoff });
          accepted.resolve();
          return; // Accepted by the destination, but the HTTP response is lost on kill.
        }
        if (req.url.startsWith("/api/automation-actions/receipts/")) {
          assert.equal(
            decodeURIComponent(req.url.split("/").at(-1)),
            handoffKey,
          );
          // The host completes admission from its durable inbox, independently
          // from the killed worker and its missing local state.
          consumeCalls++;
          consumed.resolve();
          return respond({ status: "succeeded" });
        }
        return respond({ events: [], claims: [] });
      } catch (error) {
        failure = error;
        res.writeHead(500).end("synthetic fixture failure");
      }
    });
    remote.listen(0, "127.0.0.1");
    await once(remote, "listening");
    const baseUrl = `http://127.0.0.1:${remote.address().port}`;
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const config = {
      enabled: true,
      rules: [],
      connectors: [
        {
          id: "vibe",
          type: "vibe_kanban",
          enabled: true,
          config: {
            baseUrl,
            bearerToken: "synthetic-token",
            hostBridges: { [machineId]: { baseUrl } },
          },
        },
        {
          id: "events",
          type: "vibe_events",
          enabled: true,
          config: { vibeConnectorId: "vibe", kinds: ["cloud.notification"] },
        },
      ],
      routines: [
        {
          id: "synthetic-recovery",
          enabled: true,
          trigger: {
            type: "vk_event",
            connectorId: "events",
            kinds: ["cloud.notification"],
          },
          action: {
            type: "send_prompt",
            connectorId: "vibe",
            targetHostId: machineId,
            input: {
              target: "autopilot",
              queue: true,
              prompt: "Synthetic notification",
            },
          },
        },
      ],
    };
    const start = () => {
      child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./server.mjs", import.meta.url))],
        {
          env: {
            ...process.env,
            HOST: "127.0.0.1",
            PORT: String(port),
            ADMIN_TOKEN: "synthetic-admin-token",
            AUTOMATION_DATA_DIR: directory,
          },
          stdio: "pipe",
        },
      );
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
        if (/\[persist\] write failed/.test(output))
          persistenceFailed.resolve();
      });
    };
    const stop = async () => {
      if (child?.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    };
    const waitFor = async (promise) => {
      let timer;
      try {
        await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(`worker recovery timed out: ${failure || output}`),
                ),
              8000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await writeFile(statePath, JSON.stringify(config));
      start();
      await waitFor(accepted.promise);
      await waitFor(persistenceFailed.promise);
      assert.match(output, /\[persist\] write failed/);
      await stop();
      assert.equal(consumeCalls, 0);
      // Lose all local claim/receipt caches; only configuration survives.
      await rm(statePath, { recursive: true });
      await writeFile(statePath, JSON.stringify(config));
      start();
      await waitFor(consumed.promise);
      assert.notEqual(instance, previousInstance);
      assert.equal(queueCalls, 1);
      assert.equal(consumeCalls, 1);
      assert.equal(failure, undefined);
    } finally {
      await stop();
      remote.closeAllConnections();
      await new Promise((resolve) => remote.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
