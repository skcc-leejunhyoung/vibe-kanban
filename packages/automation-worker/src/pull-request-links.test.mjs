import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPullRequestLinkOperation,
  retryPendingPullRequestLinkOperations,
} from './pull-request-links.mjs';

const enabled = () => ({ id: 'vibe', enabled: true });

test('successful retry removes the op and counts it as recovered', async () => {
  const op = {
    id: '1',
    vibeConnectorId: 'vibe',
    payload: { url: 'u', issue_id: 'i' },
    attempts: 1,
    nextAttemptAt: 0,
  };
  const posted = [];
  const res = await retryPendingPullRequestLinkOperations({
    operations: [op],
    now: 1000,
    resolveConnector: enabled,
    linkPr: async (_connector, payload) => {
      posted.push(payload);
    },
    retryDelay: (a) => a * 1000,
    maxAttempts: 5,
  });

  assert.equal(res.recovered, 1);
  assert.equal(res.changed, true);
  assert.deepEqual(res.remaining, []);
  assert.deepEqual(posted, [{ url: 'u', issue_id: 'i' }]);
});

test('failed retry below the cap keeps the op with incremented attempts and backoff', async () => {
  const op = {
    id: '1',
    vibeConnectorId: 'vibe',
    payload: { url: 'u' },
    attempts: 1,
    nextAttemptAt: 0,
  };
  const failed = [];
  const res = await retryPendingPullRequestLinkOperations({
    operations: [op],
    now: 1000,
    resolveConnector: enabled,
    linkPr: async () => {
      throw new Error('boom');
    },
    retryDelay: (a) => a * 10,
    maxAttempts: 5,
    onFailed: (o) => failed.push(o),
  });

  assert.equal(res.recovered, 0);
  assert.equal(res.changed, true);
  assert.equal(res.remaining.length, 1);
  assert.equal(op.attempts, 2);
  assert.equal(op.lastError, 'boom');
  assert.equal(op.nextAttemptAt, 1000 + 2 * 10);
  assert.deepEqual(failed, [op]);
});

test('failed retry at the cap drops the op as exhausted', async () => {
  const op = {
    id: '1',
    vibeConnectorId: 'vibe',
    payload: { url: 'u' },
    attempts: 4,
    maxAttempts: 5,
    nextAttemptAt: 0,
  };
  const exhausted = [];
  const failed = [];
  const res = await retryPendingPullRequestLinkOperations({
    operations: [op],
    now: 1000,
    resolveConnector: enabled,
    linkPr: async () => {
      throw new Error('boom');
    },
    retryDelay: (a) => a * 10,
    maxAttempts: 5,
    onFailed: (o) => failed.push(o),
    onExhausted: (o) => exhausted.push(o),
  });

  assert.equal(res.remaining.length, 0);
  assert.equal(op.attempts, 5);
  assert.deepEqual(exhausted, [op]);
  assert.deepEqual(failed, []);
});

test('not-due op is carried forward without attempting the link', async () => {
  const op = {
    id: '1',
    vibeConnectorId: 'vibe',
    payload: {},
    attempts: 1,
    nextAttemptAt: 5000,
  };
  let called = false;
  const res = await retryPendingPullRequestLinkOperations({
    operations: [op],
    now: 1000,
    resolveConnector: enabled,
    linkPr: async () => {
      called = true;
    },
    retryDelay: (a) => a,
    maxAttempts: 5,
  });

  assert.equal(called, false);
  assert.equal(res.changed, false);
  assert.deepEqual(res.remaining, [op]);
});

test('missing/disabled connector keeps the op without spending an attempt', async () => {
  const op = {
    id: '1',
    vibeConnectorId: 'gone',
    payload: {},
    attempts: 1,
    nextAttemptAt: 0,
  };
  let called = false;
  const res = await retryPendingPullRequestLinkOperations({
    operations: [op],
    now: 1000,
    resolveConnector: () => null,
    linkPr: async () => {
      called = true;
    },
    retryDelay: (a) => a,
    maxAttempts: 5,
  });

  assert.equal(called, false);
  assert.equal(res.changed, false);
  assert.equal(op.attempts, 1);
  assert.deepEqual(res.remaining, [op]);
});

test('processes a mixed batch: recovers one, retains the other', async () => {
  const ok = {
    id: 'ok',
    vibeConnectorId: 'vibe',
    payload: { url: 'ok' },
    attempts: 1,
    nextAttemptAt: 0,
  };
  const bad = {
    id: 'bad',
    vibeConnectorId: 'vibe',
    payload: { url: 'bad' },
    attempts: 1,
    nextAttemptAt: 0,
  };
  const res = await retryPendingPullRequestLinkOperations({
    operations: [ok, bad],
    now: 1000,
    resolveConnector: enabled,
    linkPr: async (_connector, payload) => {
      if (payload.url === 'bad') throw new Error('nope');
    },
    retryDelay: (a) => a,
    maxAttempts: 5,
  });

  assert.equal(res.recovered, 1);
  assert.equal(res.changed, true);
  assert.deepEqual(
    res.remaining.map((o) => o.id),
    ['bad']
  );
});

test('buildPullRequestLinkOperation captures the payload and schedules the first retry', () => {
  const op = buildPullRequestLinkOperation({
    id: 'op-1',
    vibeConnectorId: 'vibe',
    issueId: 'issue-1',
    payload: { url: 'https://github.com/o/r/pull/1' },
    now: 1000,
    maxAttempts: 5,
    retryDelay: (a) => a * 100,
    error: new Error('down'),
  });

  assert.equal(op.id, 'op-1');
  assert.equal(op.vibeConnectorId, 'vibe');
  assert.equal(op.issueId, 'issue-1');
  assert.equal(op.label, 'https://github.com/o/r/pull/1');
  assert.equal(op.attempts, 1);
  assert.equal(op.maxAttempts, 5);
  assert.equal(op.lastError, 'down');
  assert.equal(op.nextAttemptAt, 1000 + 1 * 100);
});
