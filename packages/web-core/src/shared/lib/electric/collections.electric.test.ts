import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ISSUE_MUTATION, PROJECT_ISSUES_SHAPE } from 'shared/remote-types';
import { makeRequest } from '@/shared/lib/remoteApi';
import { configureTestAuthRuntime } from './electricTestKit';
import {
  createShapeCollection,
  retryShapeSource,
  subscribeShapeErrors,
  ELECTRIC_READY_TIMEOUT_MS,
} from './collections';

// Keep the real Electric client and adapter: the shared fake skips txid waits.
vi.mock('@/shared/lib/remoteApi', () => ({
  makeRequest: vi.fn(),
  getRemoteApiUrl: () => 'http://api.test',
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const json = (body: unknown) => new Response(JSON.stringify(body));
const issue = (status_id = 'in-progress', id = 'a') => ({
  id,
  project_id: 'p',
  title: 'issue',
  status_id,
});
const collections: ReturnType<typeof createShapeCollection>[] = [];
let requests: ReturnType<typeof deferred<Response>>[];
let counter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { visibilityState: 'visible' });
  configureTestAuthRuntime();
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: unknown, init?: RequestInit) => {
      const request = deferred<Response>();
      requests.push(request);
      return Promise.race([
        request.promise,
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true }
          );
        }),
      ]);
    })
  );
  vi.mocked(makeRequest).mockReset();
});

afterEach(async () => {
  await Promise.all(
    collections.splice(0).map((collection) => collection.cleanup())
  );
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['update', 'insert', 'delete'] as const)(
  'confirms fallback %s before recovering through an initial Electric snapshot without txids',
  async (operation) => {
    const write = deferred<Response>();
    const get = deferred<Response>();
    vi.mocked(makeRequest)
      .mockResolvedValueOnce(json({ issues: [issue()] }))
      .mockReturnValueOnce(write.promise)
      .mockReturnValueOnce(get.promise);
    const collection = createShapeCollection(
      PROJECT_ISSUES_SHAPE,
      { project_id: `real-${++counter}` },
      undefined,
      ISSUE_MUTATION
    );
    collections.push(collection);
    const recovered = vi.fn();
    subscribeShapeErrors(collection, {
      onError: vi.fn(),
      onRecover: recovered,
    });
    collection.subscribeChanges(() => {});
    await vi.advanceTimersByTimeAsync(ELECTRIC_READY_TIMEOUT_MS + 10);
    const requestCount = requests.length;
    const tx =
      operation === 'insert'
        ? collection.insert(issue('in-review', 'b'))
        : operation === 'delete'
          ? collection.delete('a')
          : collection.update('a', (draft) => {
              Object.assign(draft, { status_id: 'in-review' });
            });
    const completed = vi.fn();
    const persisted = tx.isPersisted.promise.then(completed);
    retryShapeSource(collection);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(requestCount);
    write.resolve(json({ txid: 777 }));
    await vi.advanceTimersByTimeAsync(0);
    retryShapeSource(collection);
    await vi.advanceTimersByTimeAsync(5001);
    expect(requests).toHaveLength(requestCount);
    expect(completed).not.toHaveBeenCalled();
    expect(tx.state).toBe('persisting');

    const rows =
      operation === 'insert'
        ? [issue(), issue('in-review', 'b')]
        : operation === 'delete'
          ? []
          : [issue('in-review')];
    expect(collection.toArray).toEqual(rows);
    get.resolve(json({ issues: rows }));
    await persisted;
    expect(tx.state).toBe('completed');

    retryShapeSource(collection);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(requestCount + 1);
    requests.at(-1)!.resolve(
      new Response(
        JSON.stringify([
          ...rows.map((value) => ({
            key: value.id,
            value,
            headers: { operation: 'insert', relation: ['public', 'issues'] },
          })),
          { headers: { control: 'up-to-date', global_last_seen_lsn: '1' } },
        ]),
        {
          headers: {
            'content-type': 'application/json',
            'electric-handle': `real-${counter}`,
            'electric-offset': '1_0',
            'electric-cursor': '1',
            'electric-schema': JSON.stringify({
              id: { type: 'text' },
              project_id: { type: 'text' },
              title: { type: 'text' },
              status_id: { type: 'text' },
            }),
          },
        }
      )
    );
    await vi.advanceTimersByTimeAsync(5001);
    expect(collection.toArray).toEqual(rows);
    expect(tx.state).toBe('completed');
    expect(recovered).toHaveBeenCalledTimes(1);
  }
);
