import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hostId = '30000000-0000-4000-8000-000000000001';
const autopilotSession = '30000000-0000-4000-8000-000000000002';
const userExecution = '30000000-0000-4000-8000-000000000003';
const ownedExecution = '30000000-0000-4000-8000-000000000004';
const workspace = (n) => `30000000-0000-4000-8000-00000000010${n}`;

function facts(execution) {
  const owned = execution === ownedExecution;
  return {
    execution_id: execution,
    workspace_id: workspace(owned ? 2 : 1),
    execution_agent_session: owned ? autopilotSession : null,
    workspace_agent_session: null,
    autopilot: false,
    archived: false,
    review_branch: false,
    has_pr: false,
    vibe_run: false,
    execution_before_tracking: false,
    workspace_before_tracking: false,
    hostId: 'machine',
  };
}

async function runWorker(mode) {
  const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-triage-worker-'));
  const deliveries = [];
  let served = false;
  const remote = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://synthetic');
    const send = (value) => res.end(JSON.stringify(value));
    if (url.pathname === '/v1/hosts')
      return send({ hosts: [{ id: hostId, machine_id: 'machine', access_role: 'owner' }] });
    if (url.pathname === '/v1/agent-events') {
      const events = served
        ? []
        : [userExecution, ownedExecution].map((execution, i) => ({
            cursor: i + 1,
            kind: 'process.completed',
            host_id: hostId,
            host_name: 'synthetic-host',
            workspace_id: facts(execution).workspace_id,
            session_id: '30000000-0000-4000-8000-000000000200',
            execution_id: execution,
            data: { exit_code: 0 },
          }));
      served = true;
      return send({ events, cursor: 2 });
    }
    if (url.pathname.startsWith('/api/automation-actions/triage-facts/'))
      return send(facts(url.pathname.split('/').pop()));
    if (url.pathname === '/api/automation-actions/autopilot-sessions')
      return send({ hostId: 'machine', sessions: [autopilotSession] });
    if (url.pathname === '/api/automation-actions/status')
      return send({ hostId: 'machine', busy: false, notificationProtocol: 2 });
    if (url.pathname === '/api/workspaces/autopilot')
      return send({
        data: {
          session: { id: autopilotSession },
          workspace: { id: workspace(9) },
          executor_config: { executor: 'CLAUDE_CODE' },
        },
      });
    if (url.pathname === '/v1/autopilot-notification-leases')
      return send({ id: 'synthetic-lease', protocol: 2 });
    if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/')) {
      deliveries.push(JSON.parse(body));
      return send({ success: true, data: { status: 'queued', messages: [] } });
    }
    send({ claims: [], events: [], status: 'missing' });
  });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  const baseUrl = `http://127.0.0.1:${remote.address().port}`;
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  await writeFile(
    path.join(directory, 'state.json'),
    JSON.stringify({
      enabled: true,
      rules: [],
      connectors: [
        {
          id: 'vibe-default',
          type: 'vibe_kanban',
          enabled: true,
          config: { baseUrl, bearerToken: 'synthetic-token', hostBridges: { machine: { baseUrl } } },
        },
        {
          id: 'events',
          type: 'vibe_events',
          enabled: true,
          config: { vibeConnectorId: 'vibe-default', kinds: ['process.'], cursor: 0, pollSeconds: 1 },
        },
      ],
      routines: [
        {
          id: 'synthetic-autopilot',
          enabled: true,
          trigger: { type: 'vk_event', connectorId: 'events', kinds: ['process.completed'] },
          action: {
            type: 'send_prompt',
            connectorId: 'vibe-default',
            targetHostId: 'machine',
            input: { target: 'autopilot', queue: true, prompt: 'Synthetic {{events}}' },
          },
        },
      ],
    })
  );
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      ADMIN_TOKEN: 'synthetic-admin-token',
      AUTOMATION_DATA_DIR: directory,
      AUTOPILOT_TRIAGE: mode,
    },
    stdio: process.env.TRIAGE_TEST_DEBUG ? 'inherit' : 'ignore',
  });
  const api = async (method = 'GET', payload) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/autopilot/triage`, {
      method,
      headers: { authorization: 'Bearer synthetic-admin-token', 'content-type': 'application/json' },
      body: payload && JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };
  const until = async (check) => {
    for (let i = 0; i < 100; i += 1) {
      const value = await check().catch(() => null);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('timed out');
  };
  const stop = async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    remote.closeAllConnections();
    await new Promise((resolve) => remote.close(resolve));
    await rm(directory, { recursive: true, force: true });
  };
  return { deliveries, api, until, stop };
}

const decisionOf = (entries, execution) =>
  entries.find((entry) => entry.executionId === execution)?.decision;

test('shadow triage records decisions and still delivers every event', { timeout: 20000 }, async () => {
  const worker = await runWorker('shadow');
  try {
    const { entries } = (
      await worker.until(async () => {
        const result = await worker.api();
        return result.body.entries.length === 2 ? result : null;
      })
    ).body;
    assert.equal(decisionOf(entries, userExecution), 'drop');
    assert.equal(decisionOf(entries, ownedExecution), 'agent');
    await worker.until(async () => worker.deliveries.length === 2);
    assert.ok(entries.every((entry) => !entry.applied));
  } finally {
    await worker.stop();
  }
});

test('active triage keeps the user own completion away from the Autopilot', { timeout: 20000 }, async () => {
  const worker = await runWorker('active');
  try {
    await worker.until(async () => worker.deliveries.length === 1);
    const delivered = JSON.stringify(worker.deliveries);
    assert.ok(delivered.includes(ownedExecution));
    assert.ok(!delivered.includes(userExecution));
    const { body } = await worker.api();
    const drop = body.entries.find((entry) => entry.executionId === userExecution);
    assert.equal(drop.applied, true);
    assert.equal(body.mode, 'active');
    // Operators can switch a rule off and import the Autopilot's old ledger.
    assert.equal((await worker.api('PUT', { disabledRules: ['U9'] })).status, 400);
    const update = await worker.api('PUT', {
      disabledRules: ['U1'],
      legacy: { executions: [userExecution], workspaces: [] },
    });
    assert.equal(update.status, 200);
    const after = (await worker.api()).body;
    assert.deepEqual(after.disabledRules, ['U1']);
    assert.equal(after.legacy.executions, 1);
  } finally {
    await worker.stop();
  }
});
