import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Collection } from '@tanstack/react-db';
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
const snapshotRows = (rows: Array<Record<string, unknown>>) =>
  new Response(
    JSON.stringify([
      ...rows.map((value) => ({
        key: value.id,
        value,
        headers: { operation: 'insert' },
      })),
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
const snapshot = (title: string) => snapshotRows([{ ...row, title }]);

let counter = 0;
let fetcher: ReturnType<typeof vi.fn>;
let collection: Collection<Record<string, unknown>, string>;
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
  ) as unknown as Collection<Record<string, unknown>, string>;
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

it('follows a newer fallback read while confirming an earlier Electric write', async () => {
  let resolveLatest!: (response: Response) => void;
  let reads = 0;
  vi.mocked(makeRequest).mockImplementation(async (path, init) => {
    if (!path.startsWith('/v1/fallback/')) return json({ txid: 987 });
    if (++reads === 1)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      });
    return new Promise<Response>((resolve) => {
      resolveLatest = resolve;
    });
  });
  const completed = vi.fn();
  const failed = vi.fn();
  const first = collection.update(row.id, (draft) => {
    draft.title = 'saved';
  });
  void first.isPersisted.promise.then(completed, failed);
  await vi.advanceTimersByTimeAsync(0);
  retryShapeSource(collection);
  await vi.advanceTimersByTimeAsync(5001);
  const second = collection.update(row.id, (draft) => {
    draft.status_id = 'review';
  });
  void second.isPersisted.promise.then(completed, failed);
  await vi.advanceTimersByTimeAsync(0);
  expect(failed).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  resolveLatest(
    json({ issues: [{ ...row, title: 'saved', status_id: 'review' }] })
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(failed).not.toHaveBeenCalled();
  expect(completed).toHaveBeenCalledTimes(2);
  expect(collection.toArray).toEqual([
    { ...row, title: 'saved', status_id: 'review' },
  ]);
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
  let resolveNewRead!: (response: Response) => void;
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
    return new Promise((resolve) => {
      resolveNewRead = resolve;
    });
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
  expect(readCount).toBe(2);
  resolveOldRead(json({ issues: [row] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(persisted).not.toHaveBeenCalled();
  resolveNewRead(json({ issues: [{ ...row, title: 'saved' }] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(persisted).toHaveBeenCalledOnce();
  expect(collection.toArray[0].title).toBe('saved');
});

it.each(['insert', 'update', 'delete'] as const)(
  'confirms a saved %s when Electric reconnects before the REST poll completes',
  async (operation) => {
    const created = { ...row, id: 'created', title: 'new' };
    const savedRows =
      operation === 'insert'
        ? [row, created]
        : operation === 'update'
          ? [{ ...row, title: 'saved' }]
          : [];
    let reads = 0;
    vi.mocked(makeRequest).mockImplementation(async (path) => {
      if (!path.startsWith('/v1/fallback/')) return json({ txid: 987 });
      if (++reads === 1) return new Promise<Response>(() => {});
      return json({ issues: savedRows });
    });
    const transaction =
      operation === 'insert'
        ? collection.insert(created)
        : operation === 'delete'
          ? collection.delete(row.id)
          : collection.update(row.id, (draft) => {
              draft.title = 'saved';
            });
    const persisted = vi.fn();
    const failed = vi.fn();
    void transaction.isPersisted.promise.then(persisted, failed);
    await vi.advanceTimersByTimeAsync(0);

    fetcher.mockImplementationOnce(async () => snapshotRows(savedRows));
    retryShapeSource(collection);
    await vi.advanceTimersByTimeAsync(5001);

    expect(failed).not.toHaveBeenCalled();
    expect(persisted).toHaveBeenCalledOnce();
    expect(collection.toArray).toEqual(savedRows);
  }
);

it.each([
  ['2026-10-16T00:00:00Z', true],
  ['2026-10-16T09:00:00+09:00', true],
  ['2026-10-17T00:00:00Z', false],
] as const)(
  'confirms date writes by their instant when REST returns %s',
  async (storedDate, matches) => {
    vi.mocked(makeRequest).mockImplementation(async (path) =>
      path.startsWith('/v1/fallback/')
        ? json({ issues: [{ ...row, start_date: storedDate }] })
        : json({ txid: 987 })
    );
    const transaction = collection.update(row.id, (draft) => {
      draft.start_date = '2026-10-16T00:00:00.000Z';
    });
    const persisted = vi.fn();
    const failed = vi.fn();
    void transaction.isPersisted.promise.then(persisted, failed);
    await vi.advanceTimersByTimeAsync(0);
    retryShapeSource(collection);
    await vi.advanceTimersByTimeAsync(5001);

    expect(persisted).toHaveBeenCalledTimes(matches ? 1 : 0);
    expect(failed).toHaveBeenCalledTimes(matches ? 0 : 1);
  }
);

it.each([true, false])(
  'keeps a confirming REST read alive and resumes probes after confirmation (saved: %s)',
  async (saved) => {
    let resolveRead!: (response: Response) => void;
    let resolveProbe!: (response: Response) => void;
    let readSignal!: AbortSignal;
    let reads = 0;
    vi.mocked(makeRequest).mockImplementation(async (path, init) => {
      if (!path.startsWith('/v1/fallback/')) return json({ txid: 987 });
      if (++reads === 1) {
        readSignal = init!.signal!;
        return new Promise<Response>((resolve) => {
          resolveRead = resolve;
        });
      }
      return json({ issues: [{ ...row, title: 'saved' }] });
    });
    fetcher.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveProbe = resolve))
    );
    const transaction = collection.update(row.id, (draft) => {
      draft.title = 'saved';
    });
    const persisted = vi.fn();
    const failed = vi.fn();
    void transaction.isPersisted.promise.then(persisted, failed);
    await vi.advanceTimersByTimeAsync(0);
    retryShapeSource(collection);
    await vi.advanceTimersByTimeAsync(5001);

    resolveProbe(snapshot('before'));
    await vi.advanceTimersByTimeAsync(0);
    expect(readSignal.aborted).toBe(false);
    expect(persisted).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    resolveRead(
      json({ issues: [{ ...row, title: saved ? 'saved' : 'before' }] })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(persisted).toHaveBeenCalledTimes(saved ? 1 : 0);
    expect(failed).toHaveBeenCalledTimes(saved ? 0 : 1);
    expect(collection.toArray[0].title).toBe(saved ? 'saved' : 'before');

    fetcher.mockImplementationOnce(async () => snapshot('reconnected'));
    await vi.advanceTimersByTimeAsync(30_001);
    expect(collection.toArray[0].title).toBe('reconnected');
    const requests = vi.mocked(makeRequest).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_001);
    expect(makeRequest).toHaveBeenCalledTimes(requests);
  }
);

it('does not normalize date-looking text when confirming an ordinary string field', async () => {
  vi.mocked(makeRequest).mockImplementation(async (path) =>
    path.startsWith('/v1/fallback/')
      ? json({ issues: [{ ...row, title: '2026-10-16T00:00:00Z' }] })
      : json({ txid: 987 })
  );
  const transaction = collection.update(row.id, (draft) => {
    draft.title = '2026-10-16T00:00:00.000Z';
  });
  const failure = expect(transaction.isPersisted.promise).rejects.toThrow(
    'Timeout waiting for txId'
  );
  await vi.advanceTimersByTimeAsync(0);
  retryShapeSource(collection);
  await vi.advanceTimersByTimeAsync(5001);
  await failure;
});
