import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchWithRetry } from './fetch-retry.mjs';

const networkError = (code) =>
  Object.assign(new TypeError('fetch failed'), { cause: { code } });

function fakeFetch(...outcomes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([options.method || 'GET', url]);
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { calls, fetchImpl, sleep: async () => {} };
}

test('a transient failure followed by success returns the response', async () => {
  const fake = fakeFetch(networkError('UND_ERR_SOCKET'), { ok: true });
  const response = await fetchWithRetry(
    'https://api.github.com/repos/o/r/issues/1',
    {},
    fake
  );
  assert.deepEqual(response, { ok: true });
  assert.equal(fake.calls.length, 2);
});

test('connect failures replay even a POST that creates rows', async () => {
  const fake = fakeFetch(networkError('UND_ERR_CONNECT_TIMEOUT'), { ok: true });
  await fetchWithRetry(
    'https://vk.test/v1/issues',
    { method: 'POST', body: '{}' },
    fake
  );
  assert.equal(fake.calls.length, 2);
});

test('a POST that may have reached the server is not replayed', async () => {
  // 소켓이 요청 전송 후 끊겼을 수 있다 — 재전송하면 이슈/댓글이 두 번 생긴다.
  const fake = fakeFetch(networkError('UND_ERR_SOCKET'), { ok: true });
  await assert.rejects(
    fetchWithRetry('https://vk.test/v1/issues', { method: 'POST' }, fake),
    /fetch failed/
  );
  assert.equal(fake.calls.length, 1);
});

test('GraphQL POSTs are replayed after an in-flight failure', async () => {
  const timeout = new DOMException('timed out', 'TimeoutError');
  const fake = fakeFetch(timeout, { ok: true });
  await fetchWithRetry(
    'https://api.github.com/graphql',
    { method: 'POST' },
    fake
  );
  assert.equal(fake.calls.length, 2);
});

test('gives up after the attempt cap and rethrows the last error', async () => {
  const last = networkError('ECONNRESET');
  const fake = fakeFetch(
    networkError('UND_ERR_SOCKET'),
    networkError('UND_ERR_CONNECT_TIMEOUT'),
    last
  );
  await assert.rejects(
    fetchWithRetry('https://api.github.com/user', {}, fake),
    (error) => error === last
  );
  assert.equal(fake.calls.length, 3);
});

test('non-network errors are not retried', async () => {
  const fake = fakeFetch(new TypeError('Invalid URL'));
  await assert.rejects(fetchWithRetry('https://api.github.com/user', {}, fake));
  assert.equal(fake.calls.length, 1);
});
