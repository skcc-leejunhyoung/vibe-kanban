import test from 'node:test';
import assert from 'node:assert/strict';
import { eventMatchesRoutine, normalizeRoutine, redactEvent, routineEventKey, routineRunTrigger, scheduleOccurrence, validateRoutineScope } from './routines.mjs';

test('cron occurrences are keyed by local timezone minute', () => {
  const routine = normalizeRoutine({ id: 'daily', enabled: true, trigger: { type: 'schedule', cron: '30 9 * * 1-5', timezone: 'Asia/Seoul' }, action: { type: 'notification', connectorId: 'vibe', targetHostId: 'host', input: { title: 'a', message: 'b' } } });
  assert.equal(scheduleOccurrence(routine, new Date('2026-09-01T00:30:10Z')), 'cron:Asia/Seoul:2026-09-01T09:30');
  assert.equal(scheduleOccurrence(routine, new Date('2026-09-01T00:31:00Z')), null);
});

test('cron uses standard day-of-month OR day-of-week semantics', () => {
  const routine = normalizeRoutine({ id: 'weekly-or-first', enabled: true, trigger: { type: 'schedule', cron: '0 9 1 * 1', timezone: 'UTC' }, action: { type: 'notification', connectorId: 'vibe', targetHostId: 'host', input: { title: 'a', message: 'b' } } });
  assert.equal(scheduleOccurrence(routine, new Date('2026-09-07T09:00:00Z')), 'cron:UTC:2026-09-07T09:00');
});

test('schedule requires an explicit timezone', () => {
  assert.throws(() => normalizeRoutine({ trigger: { type: 'schedule', cron: '* * * * *' }, action: { type: 'notification', connectorId: 'vibe', targetHostId: 'host', input: { title: 'a', message: 'b' } } }), /timezone/);
});

test('one-time schedule interprets a local time in its timezone', () => {
  const routine = normalizeRoutine({ id: 'once', enabled: true, trigger: { type: 'schedule', at: '2026-09-02T09:00', timezone: 'Asia/Seoul' }, action: { type: 'notification', connectorId: 'vibe', targetHostId: 'host', input: { title: 'a', message: 'b' } } });
  assert.equal(scheduleOccurrence(routine, new Date('2026-09-02T00:00:00Z')), 'once:2026-09-02T00:00:00.000Z');
});

test('events reject self recursion and redact sensitive fields', () => {
  const routine = normalizeRoutine({ id: 'r1', enabled: true, trigger: { type: 'issue_created' }, action: { type: 'create_issue', connectorId: 'vibe', input: { title: 'a' } } });
  assert.equal(eventMatchesRoutine(routine, { type: 'issue_created', originRoutineId: 'r1' }), false);
  assert.deepEqual(redactEvent({ type: 'issue_created', nested: { bearerToken: 'nope', title: 'ok' } }), { type: 'issue_created', nested: { title: 'ok' } });
});

test('run history keeps only trigger identity and routing fields', () => {
  assert.deepEqual(routineRunTrigger({ id: '1', type: 'issue_created', source: 'vibe', issueId: 'issue', title: 'private title', raw: { body: 'private body' }, token: 'secret' }), { id: '1', type: 'issue_created', source: 'vibe', issueId: 'issue' });
});

test('workspace actions require explicit scope, executor and safety policies', () => {
  const base = { trigger: { type: 'issue_created' }, action: { type: 'start_workspace', connectorId: 'vibe', targetHostId: 'host', input: { prompt: 'go', repos: [{ repo_id: 'repo' }], linked_issue: { remote_project_id: 'project', issue_id: 'issue' }, executor_config: { executor: 'CODEX', variant: 'DEFAULT', permission_policy: 'DONT_ASK' }, max_execution_seconds: 60 } } };
  assert.throws(() => normalizeRoutine(base), /sandbox policy/);
  assert.doesNotThrow(() => normalizeRoutine({ ...base, action: { ...base.action, input: { ...base.action.input, executor_config: { ...base.action.input.executor_config, sandbox_policy: 'workspace-write' } } } }));
});

test('condition rule metadata is not compared with event fields', () => {
  const routine = normalizeRoutine({ id: 'r1', enabled: true, trigger: { type: 'issue_created' }, condition: { projectId: 'p1', ruleId: 'condition-1', expected: true }, action: { type: 'create_issue', connectorId: 'vibe', input: { title: 'a' } } });
  assert.equal(eventMatchesRoutine(routine, { type: 'issue_created', projectId: 'p1' }), true);
});

test('event keys include source and type', () => {
  assert.notEqual(
    routineEventKey('routine', { source: 'github', type: 'issue', id: '1' }),
    routineEventKey('routine', { source: 'vibe', type: 'issue_created', id: '1' })
  );
});

test('host scope denies projects and repositories unless explicitly allowed', () => {
  const input = { linked_issue: { remote_project_id: 'project' }, repos: [{ repo_id: 'repo' }] };
  assert.throws(() => validateRoutineScope({}, input), /project/);
  assert.doesNotThrow(() => validateRoutineScope({ projectIds: ['project'], repositoryIds: ['repo'] }, input));
  assert.throws(() => validateRoutineScope({ projectIds: ['project'], repositoryIds: [] }, { scope: { projectId: 'project', repositoryIds: ['repo'] } }), /repository/);
});

test('routine condition and action input require object shapes', () => {
  const action = { type: 'create_issue', connectorId: 'vibe', input: { title: 'a' } };
  assert.throws(() => normalizeRoutine({ trigger: { type: 'issue_created' }, condition: [], action }), /condition/);
  assert.throws(() => normalizeRoutine({ trigger: { type: 'issue_created' }, action: { ...action, input: [] } }), /action input/);
});
