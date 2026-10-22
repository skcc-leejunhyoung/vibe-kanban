import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventWorkspaceId,
  COALESCE_DEFAULTS,
  createCoalescer,
  journalEventToWorkerEvent,
  kindMatches,
  renderPromptTemplate,
} from './vibe-events.mjs';

function fakeClock() {
  let now = 1_000_000;
  let timers = [];
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timers = timers.filter((item) => item !== timer);
    },
    async advance(ms) {
      const until = now + ms;
      while (true) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        now = Math.max(now, due.at);
        await due.fn();
      }
      now = until;
    },
  };
}

function journal(cursor, kind, extra = {}) {
  return { cursor, at: '2026-10-21T05:00:00Z', kind, workspace_id: 'ws-1', session_id: 's-1', execution_id: 'e-1', data: {}, ...extra };
}

test('kind prefixes match like the server journal', () => {
  assert.equal(kindMatches('process.failed', ['process.']), true);
  assert.equal(kindMatches('process.failed', ['process.completed']), false);
  assert.equal(kindMatches('approval.pending', ['approval.*']), true);
  assert.equal(kindMatches('anything', []), true);
});

test('journal events become worker events with a human title', () => {
  const event = journalEventToWorkerEvent('host-a', journal(41, 'process.failed', { data: { exit_code: 101, name: 'vk/47fd' } }));
  assert.equal(event.id, 'host-a:41');
  assert.equal(event.type, 'vk_event');
  assert.equal(event.kind, 'process.failed');
  assert.equal(event.workspaceId, 'ws-1');
  assert.equal(event.title, 'process.failed · vk/47fd · exit 101');
});

test('prompt template renders batches and single events', () => {
  const a = journalEventToWorkerEvent('host-a', journal(1, 'process.completed', { execution_id: null }));
  const b = journalEventToWorkerEvent('host-b', journal(7, 'approval.pending', { session_id: null, execution_id: null }));
  const batch = { type: 'vk_event_batch', count: 2, events: [a, b], cursor: 7, hostIds: ['host-a', 'host-b'] };
  const text = renderPromptTemplate('n={{count}} c={{cursor}} h={{hostIds}}\n{{events}}', batch);
  assert.equal(text, [
    'n=2 c=7 h=host-a, host-b',
    '- process.completed host-a process.completed (ws ws-1, session s-1)',
    '- approval.pending host-b approval.pending (ws ws-1)',
  ].join('\n'));
  assert.equal(renderPromptTemplate('one: {{events}}', a), 'one: - process.completed host-a process.completed (ws ws-1, session s-1)');
  assert.equal(renderPromptTemplate('plain', batch), 'plain');
});

test('coalesce flushes one batch after the quiet window', async () => {
  const clock = fakeClock();
  const flushes = [];
  const coalescer = createCoalescer({ ...clock, onFlush: async (id, batch) => flushes.push([id, batch]) });
  const routine = { id: 'r', coalesce: { ...COALESCE_DEFAULTS, windowSeconds: 30 } };
  coalescer.add(routine, journalEventToWorkerEvent('h', journal(1, 'process.completed')));
  await clock.advance(20_000);
  coalescer.add(routine, journalEventToWorkerEvent('h', journal(2, 'process.completed')));
  await clock.advance(20_000);
  assert.equal(flushes.length, 0, 'window restarts on the last event');
  await clock.advance(10_000);
  assert.equal(flushes.length, 1);
  const [, batch] = flushes[0];
  assert.equal(batch.type, 'vk_event_batch');
  assert.equal(batch.count, 2);
  assert.equal(batch.id, 'batch:h:1..h:2');
  assert.equal(batch.cursor, 2);
  assert.deepEqual(batch.hostIds, ['h']);
  assert.equal(coalescer.pending('r'), 0);
});

test('immediate kinds flush now, then wait for the minimum interval', async () => {
  const clock = fakeClock();
  const flushes = [];
  const coalescer = createCoalescer({ ...clock, onFlush: async (id, batch) => flushes.push(batch) });
  const routine = { id: 'r', coalesce: { ...COALESCE_DEFAULTS, windowSeconds: 30, minIntervalSeconds: 120, immediate: ['approval.pending'] } };
  coalescer.add(routine, journalEventToWorkerEvent('h', journal(1, 'approval.pending')));
  await clock.advance(0);
  assert.equal(flushes.length, 1, 'immediate kind flushes without waiting');
  coalescer.add(routine, journalEventToWorkerEvent('h', journal(2, 'approval.pending')));
  await clock.advance(60_000);
  assert.equal(flushes.length, 1, 'held until minIntervalSeconds since the last flush');
  await clock.advance(60_000);
  assert.equal(flushes.length, 2);
  assert.equal(flushes[1].count, 1);
});

test('maxPerHour holds and merges extra flushes', async () => {
  const clock = fakeClock();
  const flushes = [];
  const coalescer = createCoalescer({ ...clock, onFlush: async (id, batch) => flushes.push(batch) });
  const routine = { id: 'r', coalesce: { ...COALESCE_DEFAULTS, windowSeconds: 1, minIntervalSeconds: 0, maxPerHour: 2 } };
  for (let i = 1; i <= 3; i += 1) {
    coalescer.add(routine, journalEventToWorkerEvent('h', journal(i, 'process.completed')));
    await clock.advance(1_000);
  }
  assert.equal(flushes.length, 2, 'third flush is held within the hour');
  coalescer.add(routine, journalEventToWorkerEvent('h', journal(4, 'process.completed')));
  await clock.advance(3_600_000);
  assert.equal(flushes.length, 3);
  assert.equal(flushes[2].count, 2, 'held events merge into the next flush');
});

test('eventWorkspaceId reads the cloud notification payload', () => {
  assert.equal(eventWorkspaceId({ workspace_id: 'ws-1' }), 'ws-1');
  assert.equal(
    eventWorkspaceId({ kind: 'cloud.notification', data: { payload: { workspace_id: 'ws-2' } } }),
    'ws-2'
  );
  assert.equal(eventWorkspaceId({ kind: 'cloud.notification', data: {} }), null);
});

test('maxWaitSeconds flushes a never-quiet burst from the first event', async () => {
  const clock = fakeClock();
  const flushes = [];
  const coalescer = createCoalescer({ ...clock, onFlush: async (id, batch) => flushes.push(batch) });
  const routine = { id: 'r', coalesce: { ...COALESCE_DEFAULTS, windowSeconds: 30, minIntervalSeconds: 0, maxWaitSeconds: 60 } };
  for (let i = 1; i <= 6; i += 1) {
    await coalescer.add(routine, journalEventToWorkerEvent('h', journal(i, 'workspace.status_note')));
    await clock.advance(20_000);
  }
  assert.equal(flushes.length, 2, 'the window never went quiet, so the cap flushed instead');
  assert.equal(flushes[0].count, 3, 'everything buffered in the first 60s');
  assert.equal(flushes[0].id, 'batch:h:1..h:3');
});

test('persisted snapshots restore into a fresh coalescer and still flush', async () => {
  const clock = fakeClock();
  const snapshots = {};
  const first = createCoalescer({ ...clock, onFlush: async () => {}, onChange: async (id, snap) => { snapshots[id] = JSON.parse(JSON.stringify(snap)); } });
  const routine = { id: 'r', coalesce: { ...COALESCE_DEFAULTS, windowSeconds: 30, minIntervalSeconds: 0 } };
  await first.add(routine, journalEventToWorkerEvent('h', journal(1, 'process.completed')));
  assert.deepEqual(Object.keys(snapshots.r).sort(), ['events', 'firstAt', 'flushes', 'lastFlushAt']);
  assert.equal(snapshots.r.events.length, 1);
  // "restart": a new coalescer loads the snapshot, nothing is lost
  const flushes = [];
  const second = createCoalescer({ ...clock, onFlush: async (id, batch) => flushes.push(batch), onChange: async (id, snap) => { snapshots[id] = snap; } });
  assert.equal(second.restore(routine, snapshots.r), 1);
  await clock.advance(30_000);
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].id, 'batch:h:1..h:1');
  assert.equal(snapshots.r.events.length, 0, 'flushed buffer is persisted empty');
  assert.equal(snapshots.r.lastFlushAt, clock.now());
});
