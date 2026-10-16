import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ISSUE_MUTATION, PROJECT_ISSUES_SHAPE } from 'shared/remote-types';
import { makeRequest } from '@/shared/lib/remoteApi';
import { configureTestAuthRuntime } from './electricTestKit';
import { createShapeCollection, retryShapeSource } from './collections';

// Keep the actual Electric adapter and client: aborts and transaction matching
// are precisely what the fake-session tests cannot exercise.
vi.mock('@/shared/lib/remoteApi', () => ({
  makeRequest: vi.fn(),
  getRemoteApiUrl: () => 'http://api.test',
}));

const row = { id: 'issue-1', project_id: 'project', title: 'before' };
const json = (body: unknown) => new Response(JSON.stringify(body));
const snapshot = (title: string) =>
  new Response(
    JSON.stringify([
      {
        key: row.id,
        value: { ...row, title },
        headers: { operation: 'insert' },
      },
      { headers: { control: 'up-to-date' } },
    ]),
    {
      headers: {
        'content-type': 'application/json',
        'electric-offset': '0_0',
        'electric-handle': 'handle',
        'electric-schema': JSON.stringify({
          id: { type: 'text' },
          project_id: { type: 'text' },
          title: { type: 'text' },
        }),
      },
    }
  );

let counter = 0;
let fetcher: ReturnType<typeof vi.fn>;
let collection: ReturnType<typeof createShapeCollection>;
let subscription: { unsubscribe: () => void };

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), { visibilityState: 'visible' })
  );
  configureTestAuthRuntime();
  fetcher = vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      })
  );
  fetcher.mockImplementationOnce(async () => snapshot('before'));
  vi.stubGlobal('fetch', fetcher);
  vi.mocked(makeRequest)
    .mockReset()
    .mockImplementation(async (path) =>
      path.startsWith('/v1/fallback/')
        ? json({ issues: [{ ...row, title: 'saved' }] })
        : json({ txid: 987 })
    );
  collection = createShapeCollection(
    PROJECT_ISSUES_SHAPE,
    { project_id: `integration${++counter}` },
    undefined,
    ISSUE_MUTATION
  );
  subscription = collection.subscribeChanges(() => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(collection.isReady()).toBe(true);
});

afterEach(async () => {
  subscription.unsubscribe();
  await collection.cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('confirms a saved update from REST when refresh interrupts its txid acknowledgement', async () => {
  const transaction = collection.update(row.id, (draft) => {
    draft.title = 'saved';
  });
  const persisted = vi.fn();
  const failed = vi.fn();
  void transaction.isPersisted.promise.then(persisted, failed);
  await vi.advanceTimersByTimeAsync(0);
  expect(persisted).not.toHaveBeenCalled();

  retryShapeSource(collection);
  await vi.advanceTimersByTimeAsync(5001);
  expect(collection.toArray[0].title).toBe('saved');
  expect(failed).not.toHaveBeenCalled();
  expect(persisted).toHaveBeenCalledOnce();
});

it('adopts a healthy reconnect despite the previous long poll being cancelled', async () => {
  fetcher.mockImplementationOnce(async () => snapshot('reconnected'));
  retryShapeSource(collection);
  await vi.advanceTimersByTimeAsync(0);
  expect(collection.toArray[0].title).toBe('reconnected');
  const requests = vi.mocked(makeRequest).mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_001);
  expect(makeRequest).toHaveBeenCalledTimes(requests);
});

it('does not mask an actual rejected write with matching fallback data', async () => {
  vi.mocked(makeRequest).mockResolvedValueOnce(
    new Response(JSON.stringify({ message: 'Write rejected' }), { status: 403 })
  );
  const transaction = collection.update(row.id, (draft) => {
    draft.title = 'saved';
  });
  const failure = expect(transaction.isPersisted.promise).rejects.toThrow(
    'Write rejected'
  );
  retryShapeSource(collection);
  await vi.advanceTimersByTimeAsync(0);
  await failure;
});

it('does not confirm a write using a stale fallback snapshot', async () => {
  vi.mocked(makeRequest).mockImplementation(async (path) =>
    path.startsWith('/v1/fallback/')
      ? json({ issues: [row] })
      : json({ txid: 987 })
  );
  const transaction = collection.update(row.id, (draft) => {
    draft.title = 'saved';
  });
  const failure = expect(transaction.isPersisted.promise).rejects.toThrow(
    'Timeout waiting for txId'
  );
  await vi.advanceTimersByTimeAsync(0);
  retryShapeSource(collection);
  await vi.advanceTimersByTimeAsync(5001);
  await failure;
});

it.each(['insert', 'delete'] as const)(
  'confirms a saved %s after its stream is refreshed',
  async (operation) => {
    const created = { ...row, id: 'created', title: 'new' };
    const rows = operation === 'insert' ? [row, created] : [];
    vi.mocked(makeRequest).mockImplementation(async (path) =>
      path.startsWith('/v1/fallback/')
        ? json({ issues: rows })
        : json({ txid: 987 })
    );
    const transaction =
      operation === 'insert'
        ? collection.insert(created)
        : collection.delete(row.id);
    const persisted = vi.fn();
    const failed = vi.fn();
    void transaction.isPersisted.promise.then(persisted, failed);
    await vi.advanceTimersByTimeAsync(0);
    retryShapeSource(collection);
    await vi.advanceTimersByTimeAsync(5001);
    expect(failed).not.toHaveBeenCalled();
    expect(persisted).toHaveBeenCalledOnce();
    expect(collection.toArray).toEqual(rows);
  }
);

it('waits for a slower REST confirmation instead of failing at the Electric timeout', async () => {
  let resolveRead!: (response: Response) => void;
  vi.mocked(makeRequest).mockImplementation(async (path) =>
    path.startsWith('/v1/fallback/')
      ? new Promise((resolve) => {
          resolveRead = resolve;
        })
      : json({ txid: 987 })
  );
  const transaction = collection.update(row.id, (draft) => {
    draft.title = 'saved';
  });
  const persisted = vi.fn();
  const failed = vi.fn();
  void transaction.isPersisted.promise.then(persisted, failed);
  await vi.advanceTimersByTimeAsync(0);
  retryShapeSource(collection);
  await vi.advanceTimersByTimeAsync(6000);
  expect(failed).not.toHaveBeenCalled();
  expect(persisted).not.toHaveBeenCalled();
  resolveRead(json({ issues: [{ ...row, title: 'saved' }] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(persisted).toHaveBeenCalledOnce();
  expect(collection.toArray[0].title).toBe('saved');
});

it('reads again after a write when refresh was already in flight', async () => {
  let resolveWrite!: (response: Response) => void;
  let resolveOldRead!: (response: Response) => void;
  let readCount = 0;
  vi.mocked(makeRequest).mockImplementation(async (path) => {
    if (!path.startsWith('/v1/fallback/'))
      return new Promise((resolve) => {
        resolveWrite = resolve;
      });
    if (++readCount === 1)
      return new Promise((resolve) => {
        resolveOldRead = resolve;
      });
    return json({ issues: [{ ...row, title: 'saved' }] });
  });
  const transaction = collection.update(row.id, (draft) => {
    draft.title = 'saved';
  });
  const persisted = vi.fn();
  void transaction.isPersisted.promise.then(persisted);
  retryShapeSource(collection);
  resolveWrite(json({ txid: 987 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(persisted).not.toHaveBeenCalled();
  resolveOldRead(json({ issues: [row] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(readCount).toBe(2);
  expect(persisted).toHaveBeenCalledOnce();
  expect(collection.toArray[0].title).toBe('saved');
});
