import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test(
  'startup retention works while disabled and overlapping conditions cannot rerun a deleted one-shot',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'synthetic-routine-worker-')
    );
    const held = [];
    let posts = 0;
    let child;
    let output = '';
    const host = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/automation-actions/status')
        return res.end(JSON.stringify({ hostId: 'synthetic-host' }));
      if (req.url === '/api/hold-condition') return held.push(res);
      if (req.url === '/hook' && req.method === 'POST') {
        posts += 1;
        return res.end('{}');
      }
      res.writeHead(404).end('{}');
    });
    async function until(check) {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Synthetic worker timed out: ${output.slice(-1000)}`);
    }
    try {
      host.listen(0, '127.0.0.1');
      await once(host, 'listening');
      const hostUrl = `http://127.0.0.1:${host.address().port}`;
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const workerPort = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      const action = {
        type: 'run_rule',
        connectorId: 'synthetic-vibe',
        targetHostId: 'synthetic-host',
        input: { ruleId: 'synthetic-post' },
      };
      await writeFile(
        path.join(directory, 'state.json'),
        JSON.stringify({
          enabled: false,
          routineClaims: {
            'synthetic-expired': {
              routineId: 'synthetic-once',
              runId: 'synthetic-old-run',
              status: 'succeeded',
              updatedAt: Date.now() - 30 * 86400000,
            },
          },
          routineIdempotency: { 'synthetic-expired': 'synthetic-old-run' },
          routineOccurrences: { 'synthetic-deleted': 'obsolete' },
          eventReceipts: {
            expired: {
              status: 'succeeded',
              receivedAt: Date.now() - 30 * 86400000,
            },
            fresh: { status: 'succeeded', receivedAt: Date.now() },
          },
          connectors: [
            {
              id: 'synthetic-vibe',
              enabled: true,
              type: 'vibe_kanban',
              config: {
                baseUrl: hostUrl,
                bearerToken: 'synthetic-token',
                hostBridges: { 'synthetic-host': { baseUrl: hostUrl } },
              },
            },
          ],
          rules: [
            {
              id: 'synthetic-condition',
              enabled: true,
              kind: 'condition',
              script:
                'async function handle(event, ctx) { const result = await ctx.actions.vibe.hostBridgeGet("/api/hold-condition"); await ctx.log("info", "synthetic-condition-complete"); return result.data.work; }',
            },
            {
              id: 'synthetic-post',
              enabled: true,
              kind: 'script',
              script: `async function handle(event, ctx) { await ctx.actions.http.request(${JSON.stringify(hostUrl + '/hook')}, { method: 'POST' }); }`,
            },
          ],
          routines: [
            {
              id: 'synthetic-once',
              enabled: true,
              trigger: {
                type: 'schedule',
                at: '2001-02-03T04:05:00Z',
                timezone: 'UTC',
              },
              condition: { ruleId: 'synthetic-condition' },
              action,
            },
            {
              id: 'synthetic-unrelated',
              enabled: false,
              trigger: {
                type: 'schedule',
                at: '2099-01-01T00:00:00Z',
                timezone: 'UTC',
              },
              action,
            },
          ],
        })
      );
      child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./server.mjs', import.meta.url))],
        {
          env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(workerPort),
            ADMIN_TOKEN: 'synthetic-admin',
            AUTOMATION_DATA_DIR: directory,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      const request = async (endpoint, method = 'GET', body) => {
        const response = await fetch(
          `http://127.0.0.1:${workerPort}${endpoint}`,
          {
            method,
            headers: {
              authorization: 'Bearer synthetic-admin',
              'content-type': 'application/json',
            },
            body: body && JSON.stringify(body),
          }
        );
        assert.equal(response.ok, true, `${method} ${endpoint}`);
        return response.json();
      };
      await until(() => output.includes('listening on'));
      const initial = await request('/api/state');
      assert.deepEqual(initial.routineClaims, {});
      assert.deepEqual(initial.routineIdempotency, {});
      assert.deepEqual(initial.routineOccurrences, {});
      assert.equal(initial.eventReceipts.expired, undefined);
      assert.ok(initial.eventReceipts.fresh);
      assert.equal(held.length, 0);
      await request('/api/settings', 'PATCH', { enabled: true });
      await until(() => held.length === 1);
      await request('/api/settings', 'PATCH', { enabled: true });
      await until(() => held.length === 2);
      held[0].end(JSON.stringify({ data: { work: true } }));
      await until(
        async () =>
          posts === 1 && (await request('/api/state')).routines.length === 1
      );
      await request('/api/routines/synthetic-unrelated', 'DELETE');
      assert.equal(
        Object.keys((await request('/api/state')).routineClaims).length,
        0
      );
      held[1].end(JSON.stringify({ data: { work: true } }));
      await until(
        async () =>
          (await request('/api/logs')).filter(
            (entry) => entry.message === 'synthetic-condition-complete'
          ).length === 2
      );
      const state = await request('/api/state');
      assert.equal(
        state.routineRuns.length,
        1,
        'the deleted one-shot must not create a second run'
      );
      assert.equal(state.routines.length, 0);
      assert.equal(posts, 1);
    } finally {
      if (child && child.exitCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
      for (const res of held) if (!res.writableEnded) res.end('{}');
      host.closeAllConnections();
      await new Promise((resolve) => host.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
