import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise bootstrap too: replaying the router alone misses interrupted-run recovery.
test(
  'worker startup recovers a persisted result receipt without another agent admission',
  { timeout: 15000 },
  async () => {
    const folder = await mkdtemp(
      path.join(tmpdir(), 'synthetic-autopilot-recovery-')
    );
    const executionId = '10000000-0000-4000-8000-000000000001';
    const sourceHostId = '10000000-0000-4000-8000-000000000002';
    const calls = [];
    const host = createServer((request, response) => {
      calls.push({ method: request.method, path: request.url });
      response.setHeader('content-type', 'application/json');
      let body;
      if (request.url === '/api/automation-actions/status')
        body = { hostId: 'synthetic-machine' };
      else if (request.url === '/api/workspaces/autopilot')
        body = {
          data: {
            session: { id: 'synthetic-session' },
            executor_config: { executor: 'CODEX' },
          },
        };
      else if (request.url === '/v1/hosts')
        body = {
          hosts: [
            {
              id: sourceHostId,
              machine_id: 'synthetic-machine',
              access_role: 'owner',
            },
          ],
        };
      else if (request.url.startsWith('/api/automation-actions/receipts/'))
        body = { status: 'missing' };
      else if (request.url.endsWith(`/autopilot-results/${executionId}`))
        body = {
          hostId: 'synthetic-machine',
          execution_id: executionId,
          eligible: false,
          receipt: {
            action: 'autopilot_result',
            status: 'recorded',
            execution_id: executionId,
          },
        };
      else {
        response.statusCode = 500;
        body = { error: 'unexpected synthetic request' };
      }
      response.end(JSON.stringify(body));
    });
    await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const baseUrl = `http://127.0.0.1:${host.address().port}`;
    const key = 'synthetic-interrupted-admission';
    const routine = {
      id: 'synthetic-routine',
      enabled: true,
      trigger: { type: 'execution_completed' },
      action: {
        type: 'send_prompt',
        connectorId: 'vibe-default',
        targetHostId: 'synthetic-machine',
        input: {
          target: 'autopilot',
          queue: true,
          prompt: 'Inspect synthetic results',
        },
      },
    };
    const state = {
      enabled: true,
      connectors: [
        {
          id: 'vibe-default',
          type: 'vibe_kanban',
          enabled: true,
          config: {
            baseUrl,
            bearerToken: 'synthetic-token',
            hostBridges: { 'synthetic-machine': { baseUrl } },
          },
        },
      ],
      routines: [routine],
      routineClaims: {
        [key]: {
          runId: 'synthetic-run',
          routineId: routine.id,
          status: 'running',
          autopilotRouting: {
            mode: 'active',
            targetHostId: 'synthetic-machine',
            connectorId: 'vibe-default',
            minConfidence: 0.99,
            candidate: { status: 'completed' },
          },
        },
      },
      routineRuns: [
        {
          id: 'synthetic-run',
          routineId: routine.id,
          idempotencyKey: key,
          status: 'running',
          startedAt: new Date().toISOString(),
          trigger: {
            id: 'synthetic-event',
            kind: 'process.completed',
            executionId,
            hostId: sourceHostId,
          },
        },
      ],
    };
    await writeFile(path.join(folder, 'state.json'), JSON.stringify(state));
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./server.mjs', import.meta.url))],
      {
        env: {
          PATH: process.env.PATH,
          PORT: String(port),
          HOST: '127.0.0.1',
          ADMIN_TOKEN: 'synthetic-token',
          AUTOMATION_DATA_DIR: folder,
          AUTOPILOT_DECISIONS_ACTIVE: 'false',
          AUTOPILOT_DECISIONS_SHADOW: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let diagnostic = '';
    child.stderr.on('data', (data) => {
      diagnostic += data;
    });
    child.stdout.resume();
    try {
      let saved;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null)
          assert.fail(`worker exited: ${diagnostic}`);
        saved = JSON.parse(
          await readFile(path.join(folder, 'state.json'), 'utf8')
        );
        if (saved.routineClaims[key]?.status === 'succeeded') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(
        saved.routineClaims[key].status,
        'succeeded',
        JSON.stringify({ diagnostic, retry: saved.retryQueue, calls })
      );
      assert.equal(saved.retryQueue.length, 0);
      assert.equal(saved.routineClaims[key].autopilotRouting.suppressed, true);
      assert.equal(
        calls.filter((row) => row.path.includes('autopilot-results')).length,
        1
      );
      assert.equal(calls.filter((row) => row.method === 'POST').length, 0);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      await new Promise((resolve) => host.close(resolve));
      await rm(folder, { recursive: true, force: true });
    }
  }
);
