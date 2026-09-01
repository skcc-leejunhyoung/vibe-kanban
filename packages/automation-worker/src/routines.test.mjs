import test from 'node:test';
import assert from 'node:assert/strict';
import { eventMatchesRoutine, normalizeRoutine, redactEvent, scheduleOccurrence } from './routines.mjs';

test('cron occurrences are keyed by local timezone minute', () => {
  const routine = normalizeRoutine({ id: 'daily', enabled: true, trigger: { type: 'schedule', cron: '30 9 * * 1-5', timezone: 'Asia/Seoul' }, action: { type: 'notification' } });
  assert.equal(scheduleOccurrence(routine, new Date('2026-09-01T00:30:10Z')), 'cron:Asia/Seoul:2026-09-01T09:30');
  assert.equal(scheduleOccurrence(routine, new Date('2026-09-01T00:31:00Z')), null);
});

test('events reject self recursion and redact sensitive fields', () => {
  const routine = normalizeRoutine({ id: 'r1', enabled: true, trigger: { type: 'issue_created' }, action: { type: 'create_issue' } });
  assert.equal(eventMatchesRoutine(routine, { type: 'issue_created', originRoutineId: 'r1' }), false);
  assert.deepEqual(redactEvent({ type: 'issue_created', token: 'nope', title: 'ok' }), { type: 'issue_created', title: 'ok' });
});
