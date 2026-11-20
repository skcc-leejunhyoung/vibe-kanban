import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTriage,
  decide,
  isCandidate,
  isHoldout,
  legacySets,
  pruneJournal,
  scoreTriage,
} from './autopilot-triage.mjs';
import { createNotificationRouting } from './notification-routing.mjs';

const autopilotSession = '20000000-0000-4000-8000-000000000001';
const userFacts = {
  execution_id: '20000000-0000-4000-8000-000000000002',
  workspace_id: '20000000-0000-4000-8000-000000000003',
  execution_agent_session: null,
  workspace_agent_session: null,
  autopilot: false,
  archived: false,
  review_branch: false,
  has_pr: false,
  vibe_run: true,
  execution_before_tracking: false,
  workspace_before_tracking: false,
  hostId: 'synthetic-machine',
};
const sessions = new Set([autopilotSession]);
const verdict = (facts, legacy = null) => decide({ facts, sessions, legacy });

test('the user own completion without a pull request skips the Autopilot', () => {
  assert.deepEqual(verdict(userFacts), {
    decision: 'drop',
    rule: 'U1',
    reason: 'unowned_completion',
  });
});

test('work the Autopilot dispatched, reviews, pull requests and unknown facts wake it', () => {
  const reasons = [
    [{ ...userFacts, execution_agent_session: autopilotSession }, 'autopilot_dispatched'],
    [{ ...userFacts, workspace_agent_session: autopilotSession }, 'autopilot_dispatched'],
    [{ ...userFacts, has_pr: true }, 'pull_request'],
    [{ ...userFacts, review_branch: true }, 'review_branch'],
    [{ ...userFacts, autopilot: true }, 'autopilot_workspace'],
    [{ execution_id: userFacts.execution_id, missing: true }, 'facts_unavailable'],
    [null, 'facts_unavailable'],
  ];
  for (const [facts, reason] of reasons) {
    assert.equal(verdict(facts).decision, 'agent', reason);
    assert.equal(verdict(facts).reason, reason);
  }
  // Another agent's session is not the Autopilot's.
  assert.equal(
    verdict({ ...userFacts, execution_agent_session: '20000000-0000-4000-8000-0000000000ff' }).decision,
    'drop'
  );
});

test('executions older than origin tracking need the imported Autopilot ledger', () => {
  const old = { ...userFacts, workspace_before_tracking: true };
  assert.equal(verdict(old).reason, 'origin_unknown');
  const empty = legacySets({ importedAt: '2001-01-01T00:00:00Z', executions: [], workspaces: [] });
  assert.equal(verdict(old, empty).decision, 'drop');
  const dispatched = legacySets({
    importedAt: '2001-01-01T00:00:00Z',
    executions: [userFacts.execution_id],
    workspaces: [],
  });
  assert.equal(verdict(old, dispatched).reason, 'autopilot_dispatched');
  const delegated = legacySets({
    importedAt: '2001-01-01T00:00:00Z',
    executions: [],
    workspaces: [userFacts.workspace_id],
  });
  assert.equal(verdict(old, delegated).reason, 'autopilot_dispatched');
  assert.equal(legacySets(null), null);
});

test('only completions and bound completion alerts are candidates', () => {
  const completion = { kind: 'process.completed', executionId: 'e', hostId: 'h' };
  assert.equal(isCandidate(completion), true);
  assert.equal(isCandidate({ ...completion, kind: 'process.killed' }), true);
  assert.equal(isCandidate({ ...completion, kind: 'process.failed' }), false);
  assert.equal(isCandidate({ kind: 'process.completed', executionId: 'e' }), false);
  const alert = {
    kind: 'cloud.notification',
    notificationType: 'workspace_task_completed',
    notificationIntent: 'raw_event',
    notificationId: 'n',
  };
  assert.equal(isCandidate(alert), true);
  assert.equal(isCandidate({ ...alert, notificationType: 'pull_request_comment_added' }), false);
  assert.equal(isCandidate({ ...alert, notificationIntent: 'legacy' }), false);
  assert.equal(isCandidate({ kind: 'approval.pending' }), false);
});

test('triage records every decision and falls back to the agent when a read fails', async () => {
  const records = new Map();
  const make = (facts, known) =>
    createTriage({
      facts,
      sessions: known,
      legacy: () => null,
      record: (id, entry) => records.set(id, entry),
      now: () => Date.parse('2001-02-03T04:05:06Z'),
    });
  const drop = await make(async () => userFacts, async () => sessions)({
    id: 'synthetic-event',
    kind: 'process.completed',
    executionId: userFacts.execution_id,
    hostId: 'synthetic-host',
  });
  assert.equal(drop.decision, 'drop');
  assert.equal(drop.workspaceId, userFacts.workspace_id);
  assert.equal(drop.sourceMachineId, 'synthetic-machine');
  assert.equal(records.get('synthetic-event'), drop);
  for (const [facts, known] of [
    [async () => { throw new Error('host offline'); }, async () => sessions],
    [async () => userFacts, async () => { throw new Error('session list failed'); }],
  ]) {
    const entry = await make(facts, known)({ id: 'failed-read', kind: 'process.completed' });
    assert.equal(entry.decision, 'agent');
    assert.equal(entry.reason, 'facts_unavailable');
    assert.equal(entry.holdout, false);
  }
});

test('the holdout keeps a stable few percent of drops on the agent path', () => {
  const ids = Array.from({ length: 4000 }, (_, i) => `synthetic-${i}`);
  const share = ids.filter(isHoldout).length / ids.length;
  assert.ok(share > 0.03 && share < 0.07, `holdout share ${share}`);
  assert.equal(isHoldout('synthetic-7'), isHoldout('synthetic-7'));
});

test('the journal keeps 14 days and at most the newest entries', () => {
  const now = Date.parse('2001-02-20T00:00:00Z');
  const journal = {
    old: { at: '2001-01-01T00:00:00.000Z' },
    a: { at: '2001-02-18T00:00:00.000Z' },
    b: { at: '2001-02-19T00:00:00.000Z' },
  };
  assert.deepEqual(Object.keys(pruneJournal(journal, now)), ['a', 'b']);
  assert.deepEqual(Object.keys(pruneJournal(journal, now, 1)), ['b']);
});

function routingFixture() {
  const calls = [];
  let fail;
  const routing = createNotificationRouting({
    instanceId: 'synthetic-instance',
    api: async (_, method, path, payload) => {
      calls.push({ method, path, payload });
      if (path === '/v1/hosts')
        return { hosts: [{ id: 'host', machine_id: 'machine', access_role: 'owner' }] };
      if (path === '/v1/autopilot-notification-leases') return { id: 'lease', protocol: 2 };
      if (fail?.(path)) throw Object.assign(new Error('expired'), { status: 409 });
      if (path.endsWith('/claim'))
        return { data: { claim_token: 'token', handoff_expires_in_ms: 600000 } };
      return { data: {} };
    },
  });
  return { routing, calls, failOn: (match) => (fail = match) };
}

const routine = { id: 'synthetic-routine', action: { targetHostId: 'machine' } };
const alert = () => ({
  id: 'agent-event:1',
  kind: 'cloud.notification',
  notificationType: 'workspace_task_completed',
  notificationIntent: 'raw_event',
  notificationId: 'synthetic-alert',
  notificationRevision: 1,
});
const proof = {
  rule: 'U1',
  version: 1,
  execution_id: userFacts.execution_id,
  workspace_id: userFacts.workspace_id,
  source_machine_id: 'machine',
};

test('a triaged alert is frozen with its proof and consumed without a host queue', async () => {
  const { routing, calls } = routingFixture();
  await routing.register(routine, ['cloud.notification'], true);
  const event = alert();
  assert.equal(await routing.claim(routine, event), true);
  assert.equal(await routing.disposeByRule(routine, event, proof), true);
  const [handoff, consume] = calls.slice(-2);
  assert.match(handoff.path, /\/synthetic-alert\/handoff$/);
  assert.equal(handoff.payload.handoff_key, 'triage:U1:synthetic-alert:1');
  assert.equal(handoff.payload.handoff.kind, 'triage');
  assert.equal(handoff.payload.handoff.execution_id, userFacts.execution_id);
  assert.match(consume.path, /\/synthetic-alert\/consume$/);
  assert.equal(consume.payload.handoff_key, 'triage:U1:synthetic-alert:1');
  assert.equal(consume.payload.claim_token, 'token');
  assert.ok(!calls.some((call) => call.path.includes('notification-handoff')));
});

test('an unclaimed alert is left to the normal path and an expired one to the user', async () => {
  const { routing, calls, failOn } = routingFixture();
  await routing.register(routine, ['cloud.notification'], true);
  assert.equal(await routing.disposeByRule(routine, alert(), proof), null);
  const event = alert();
  await routing.claim(routine, event);
  failOn((path) => path.endsWith('/consume'));
  assert.equal(await routing.disposeByRule(routine, event, proof), false);
  assert.ok(calls.some((call) => call.path.endsWith('/handoff')));
});

test('recovery finishes consuming a frozen triage disposition', async () => {
  const calls = [];
  const routing = createNotificationRouting({
    instanceId: 'synthetic-instance',
    api: async (_, method, path, payload) => {
      calls.push({ method, path, payload });
      if (path === '/v1/hosts')
        return { hosts: [{ id: 'host', machine_id: 'machine', access_role: 'owner' }] };
      if (path === '/v1/autopilot-notification-leases') return { id: 'lease', protocol: 2 };
      if (path.startsWith('/v1/notification-claims?'))
        return {
          claims: [
            {
              id: 'synthetic-alert',
              revision: 1,
              type: 'workspace_task_completed',
              claim_token: 'token',
              handoff_key: 'triage:U1:synthetic-alert:1',
              handoff: { kind: 'triage', ...proof },
            },
          ],
        };
      return { data: {} };
    },
  });
  await routing.register(routine, ['cloud.notification'], true);
  assert.deepEqual(await routing.recover(routine), []);
  const consume = calls.find((call) => call.path.endsWith('/consume'));
  assert.equal(consume.payload.handoff_key, 'triage:U1:synthetic-alert:1');
  assert.ok(!calls.some((call) => call.path.includes('/receipts/')));
});

test('scoring counts only labelled drops and flags a rule the agent disagreed with', () => {
  const drop = (id, extra = {}) => ({ id, decision: 'drop', rule: 'U1', executionId: id, ...extra });
  const entries = [
    drop('quiet-1'),
    drop('quiet-2'),
    drop('acted'),
    drop('pending'),
    drop('applied', { applied: true }),
    drop('holdout', { applied: true, holdout: true }),
    { id: 'agent', decision: 'agent', rule: null, executionId: 'agent' },
  ];
  const items = {
    'exec:quiet-1': { status: 'noop' },
    'exec:quiet-2': { status: 'noop' },
    'exec:acted': { status: 'drawer' },
    'exec:pending': { status: 'open' },
    'exec:holdout': { status: 'noop' },
  };
  const { U1 } = scoreTriage(entries, items, 3);
  assert.equal(U1.drops, 6);
  assert.equal(U1.applied, 1);
  assert.equal(U1.labelled, 4);
  assert.equal(U1.noop, 3);
  assert.equal(U1.acted, 1);
  assert.equal(U1.unlabelled, 1);
  assert.deepEqual(U1.misses, [{ id: 'acted', executionId: 'acted', status: 'drawer' }]);
  assert.equal(U1.promotable, false);
  const clean = scoreTriage(entries.filter((entry) => entry.id !== 'acted'), items, 3).U1;
  assert.equal(clean.promotable, true);
});
