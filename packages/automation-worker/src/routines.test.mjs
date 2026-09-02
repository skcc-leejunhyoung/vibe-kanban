import test from 'node:test';
import assert from 'node:assert/strict';
import { eventMatchesRoutine, normalizeRoutine, redactEvent, scheduleOccurrence } from './routines.mjs';

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

test('events reject self recursion and redact sensitive fields', () => {
  const routine = normalizeRoutine({ id: 'r1', enabled: true, trigger: { type: 'issue_created' }, action: { type: 'create_issue', connectorId: 'vibe', input: { title: 'a' } } });
  assert.equal(eventMatchesRoutine(routine, { type: 'issue_created', originRoutineId: 'r1' }), false);
  assert.deepEqual(redactEvent({ type: 'issue_created', nested: { bearerToken: 'nope', title: 'ok' } }), { type: 'issue_created', nested: { title: 'ok' } });
});
