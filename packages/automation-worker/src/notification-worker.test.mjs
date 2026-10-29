import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test(
  "a stalled Autopilot host cannot block another routine registration",
  { timeout: 10000 },
  async () => {
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
      if (req.url === "/api/automation-actions/status")
        return res.end(
          JSON.stringify({ hostId: "healthy", notificationProtocol: 1 }),
        );
      if (req.url === "/api/workspaces/autopilot")
        return res.end(
          JSON.stringify({ data: { session: { id: "synthetic-session" } } }),
        );
      if (req.url === "/v1/autopilot-notification-leases") {
        let body = "";
        for await (const part of req) body += part;
        registered(JSON.parse(body));
        return res.end(JSON.stringify({ id: "synthetic-lease" }));
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
      assert.equal(result.host_id, "healthy");
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
