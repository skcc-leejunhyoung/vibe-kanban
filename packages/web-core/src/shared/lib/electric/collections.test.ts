import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ISSUE_MUTATION,
  PROJECT_GITHUB_ISSUE_LINKS_SHAPE,
  PROJECT_ISSUES_SHAPE,
} from 'shared/remote-types';
import { makeRequest } from '@/shared/lib/remoteApi';
import {
  configureTestAuthRuntime,
  electricSessions,
  emitChange,
  emitError,
  emitSnapshot,
  lastSessionFor,
  resetElectricSessions,
  shapeOptionsById,
} from './electricTestKit';
import {
  createShapeCollection,
  retryShapeSource,
  subscribeShapeErrors,
  ELECTRIC_PROBE_BASE_DELAY_MS,
  ELECTRIC_READY_TIMEOUT_MS,
  FALLBACK_REFRESH_INTERVAL_MS,
  FALLBACK_REQUEST_TIMEOUT_MS,
  GITHUB_ISSUE_LINK_COLUMNS,
  SHAPE_GC_TIME_MS,
} from './collections';

vi.mock('@tanstack/electric-db-collection', async () => {
  const kit = await import('./electricTestKit');
  return { electricCollectionOptions: kit.fakeElectricCollectionOptions };
});
vi.mock('@/shared/lib/remoteApi', () => ({
  makeRequest: vi.fn(),
  getRemoteApiUrl: () => 'http://api.test',
}));

type MutationHandler = (params: {
  transaction: { mutations: Array<{ key: string; changes: unknown }> };
}) => Promise<unknown>;

const row = (id: string) => ({ id, project_id: 'x', title: id });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
const ids = (collection: { toArray: unknown }) =>
  (collection.toArray as Array<{ id: string }>).map((r) => r.id);
const sessionsFor = (id: string) =>
  electricSessions.filter((s) => s.id === id || s.id.startsWith(`${id}-`));

let auth: ReturnType<typeof configureTestAuthRuntime>;
let counter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { visibilityState: 'visible' });
  resetElectricSessions();
  auth = configureTestAuthRuntime();
  vi.mocked(makeRequest).mockReset();
  vi.mocked(makeRequest).mockImplementation(async (path: string) =>
    path.startsWith('/v1/fallback/')
      ? json({ issues: [row('fallback')] })
      : json({ txid: 7 })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Unique params per test so the module-level cache never leaks between them. */
function params() {
  return { project_id: `p${++counter}` };
}

describe('collection cache', () => {
  it('serves read-only and mutating callers from one collection', async () => {
    const p = params();
    const readOnly = createShapeCollection(PROJECT_ISSUES_SHAPE, p);
    const mutating = createShapeCollection(
      PROJECT_ISSUES_SHAPE,
      p,
      undefined,
      ISSUE_MUTATION
    );

    expect(mutating).toBe(readOnly);

    // The handler resolves the definition registered by the mutating caller.
    const onUpdate = readOnly.config.onUpdate as MutationHandler;
    await expect(
      onUpdate({ transaction: { mutations: [{ key: 'a', changes: {} }] } })
    ).resolves.toEqual({ txid: [7] });
    expect(makeRequest).toHaveBeenCalledWith(
      '/v1/issues/a',
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  it('evicts a garbage-collected collection and stops its stream', async () => {
    const p = params();
    const first = createShapeCollection(PROJECT_ISSUES_SHAPE, p);
    const subscription = first.subscribeChanges(() => {});
    const session = lastSessionFor(`issues-${p.project_id}`);
    emitSnapshot(session, [row('a')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.status).toBe('ready');
    expect(auth.registerShape).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(SHAPE_GC_TIME_MS + 10);

    expect(first.status).toBe('cleaned-up');
    expect(session.cleanup).toHaveBeenCalledTimes(1);
    expect(auth.unregisterShape).toHaveBeenCalledTimes(1);
    expect(createShapeCollection(PROJECT_ISSUES_SHAPE, p)).not.toBe(first);
  });

  it('projects github_issue_links to the columns the UI reads', () => {
    const p = params();
    createShapeCollection(PROJECT_GITHUB_ISSUE_LINKS_SHAPE, p);
    createShapeCollection(PROJECT_ISSUES_SHAPE, p);

    expect(
      shapeOptionsById.get(`github_issue_links-${p.project_id}`)?.params
    ).toMatchObject({ columns: GITHUB_ISSUE_LINK_COLUMNS.join(',') });
    expect(
      shapeOptionsById.get(`issues-${p.project_id}`)?.params
    ).not.toHaveProperty('columns');
  });
});

describe('fallback recovery', () => {
  it.each([
    { message: 'Load cancelled' },
    { name: 'AbortError', message: 'Aborted' },
    { status: 401, message: 'Unauthorized' },
    { status: 403, message: 'Forbidden' },
  ])(
    'recovers an initial stream error without accepting an empty snapshot: %j',
    async (error) => {
      const p = params();
      let resolve!: (response: Response) => void;
      vi.mocked(makeRequest).mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
      const collection = createShapeCollection(PROJECT_ISSUES_SHAPE, p);
      const subscription = collection.subscribeChanges(() => {});

      emitError(lastSessionFor(`issues-${p.project_id}`), error);
      await vi.advanceTimersByTimeAsync(0);
      expect(collection.isReady()).toBe(false);
      expect(makeRequest).toHaveBeenCalledTimes(1);

      resolve(json({ issues: [row('recovered')] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(collection.isReady()).toBe(true);
      expect(ids(collection)).toEqual(['recovered']);
      subscription.unsubscribe();
    }
  );

  it('refreshes a ready stream immediately, preserving rows until the response arrives', async () => {
    const p = params();
    const collection = createShapeCollection(PROJECT_ISSUES_SHAPE, p);
    const subscription = collection.subscribeChanges(() => {});
    const initial = lastSessionFor(`issues-${p.project_id}`);
    emitSnapshot(initial, [row('old')]);
    await vi.advanceTimersByTimeAsync(0);
    let resolve!: (response: Response) => void;
    vi.mocked(makeRequest).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );

    retryShapeSource(collection);
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(ids(collection)).toEqual(['old']);
    expect(initial.cleanup).toHaveBeenCalledTimes(1);

    resolve(json({ issues: [row('fresh')] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(collection)).toEqual(['fresh']);
    subscription.unsubscribe();
  });

  it('recovers when the initial stream stops halfway through a snapshot', async () => {
    const p = params();
    const collection = createShapeCollection(PROJECT_ISSUES_SHAPE, p);
    const subscription = collection.subscribeChanges(() => {});
    const initial = lastSessionFor(`issues-${p.project_id}`);
    initial.params.begin();
    initial.params.write({ type: 'insert', value: row('partial') });
    emitError(initial, { message: 'Cancelled' });

    await vi.advanceTimersByTimeAsync(0);
    expect(ids(collection)).toEqual(['fallback']);
    expect(collection.isReady()).toBe(true);
    subscription.unsubscribe();
  });

  it('keeps a failed first REST load pending and clears the error after retry succeeds', async () => {
    const p = params();
    const collection = createShapeCollection(PROJECT_ISSUES_SHAPE, p);
    const subscription = collection.subscribeChanges(() => {});
    vi.mocked(makeRequest).mockRejectedValueOnce(new Error('Offline'));
    await vi.advanceTimersByTimeAsync(ELECTRIC_READY_TIMEOUT_MS + 10);
    expect(collection.isReady()).toBe(false);

    const listener = { onError: vi.fn(), onRecover: vi.fn() };
    const unsubscribeError = subscribeShapeErrors(collection, listener);
    expect(listener.onError).toHaveBeenCalledWith({ message: 'Offline' });

    retryShapeSource(collection);
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(collection)).toEqual(['fallback']);
    expect(listener.onRecover).toHaveBeenCalledTimes(1);

    // A recurrence after recovery must not be hidden by error debouncing.
    vi.mocked(makeRequest).mockRejectedValueOnce(new Error('Offline'));
    retryShapeSource(collection);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener.onError).toHaveBeenCalledTimes(2);
    expect(ids(collection)).toEqual(['fallback']);
    unsubscribeError();
    subscription.unsubscribe();
  });

  it('releases a hung REST request so a manual retry can recover', async () => {
    const p = params();
    const collection = createShapeCollection(PROJECT_ISSUES_SHAPE, p);
    const subscription = collection.subscribeChanges(() => {});
    vi.mocked(makeRequest).mockImplementationOnce(() => new Promise(() => {}));
    retryShapeSource(collection);
    const signal = vi.mocked(makeRequest).mock.calls[0][1]?.signal;

    await vi.advanceTimersByTimeAsync(FALLBACK_REQUEST_TIMEOUT_MS + 1);
    expect(signal?.aborted).toBe(true);
    expect(collection.isReady()).toBe(false);
    const listener = { onError: vi.fn() };
    const stop = subscribeShapeErrors(collection, listener);
    expect(listener.onError).toHaveBeenCalledWith({
      message: 'Loading issues timed out',
    });

    retryShapeSource(collection);
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(collection)).toEqual(['fallback']);
    stop();
    subscription.unsubscribe();
  });

  it('does not replace loaded rows with an errored probe and reports REST failure during the probe', async () => {
    const p = params();
    const { collection, subscription } = await enterFallback(p);
    const listener = { onError: vi.fn() };
    const stop = subscribeShapeErrors(collection, listener);
    vi.mocked(makeRequest).mockRejectedValueOnce(new Error('Still offline'));
    retryShapeSource(collection);
    emitError(lastSessionFor(`issues-${p.project_id}`), {
      status: 503,
      message: 'Unavailable',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(ids(collection)).toEqual(['fallback']);
    expect(listener.onError).toHaveBeenCalledWith({ message: 'Still offline' });
    stop();
    subscription.unsubscribe();
  });

  it('accepts a genuinely empty snapshot as successfully loaded', async () => {
    const collection = createShapeCollection(PROJECT_ISSUES_SHAPE, params());
    const subscription = collection.subscribeChanges(() => {});
    emitSnapshot(electricSessions[electricSessions.length - 1], []);
    await vi.advanceTimersByTimeAsync(0);
    expect(collection.isReady()).toBe(true);
    expect(ids(collection)).toEqual([]);
    expect(makeRequest).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('ignores an old REST response after Electric has recovered', async () => {
    const p = params();
    const { collection, subscription } = await enterFallback(p);
    let resolve!: (response: Response) => void;
    vi.mocked(makeRequest).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    retryShapeSource(collection);
    const signal = vi.mocked(makeRequest).mock.calls.at(-1)?.[1]?.signal;
    emitSnapshot(lastSessionFor(`issues-${p.project_id}`), [row('live')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);

    resolve(json({ issues: [row('stale')] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(collection)).toEqual(['live']);
    subscription.unsubscribe();
  });

  async function enterFallback(p: { project_id: string }) {
    const collection = createShapeCollection(
      PROJECT_ISSUES_SHAPE,
      p,
      undefined,
      ISSUE_MUTATION
    );
    const subscription = collection.subscribeChanges(() => {});
    const initial = lastSessionFor(`issues-${p.project_id}`);
    // Electric never reaches up-to-date: the ready timeout locks the source
    // to the REST fallback.
    await vi.advanceTimersByTimeAsync(ELECTRIC_READY_TIMEOUT_MS + 10);
    expect(initial.cleanup).toHaveBeenCalledTimes(1);
    expect(ids(collection)).toEqual(['fallback']);
    return { collection, subscription };
  }

  it('swaps back to Electric the moment a background probe is up-to-date', async () => {
    const p = params();
    const { collection, subscription } = await enterFallback(p);
    const id = `issues-${p.project_id}`;
    const onUpdate = collection.config.onUpdate as MutationHandler;
    await expect(
      onUpdate({
        transaction: { mutations: [{ key: 'fallback', changes: {} }] },
      })
    ).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(ELECTRIC_PROBE_BASE_DELAY_MS);
    expect(sessionsFor(id)).toHaveLength(2);
    const probe = lastSessionFor(id);

    // Probe rows are held back until up-to-date, so nothing flashes empty.
    probe.params.begin();
    probe.params.write({ type: 'insert', value: row('live'), metadata: {} });
    expect(ids(collection)).toEqual(['fallback']);
    probe.params.commit();
    probe.params.markReady();
    // The swap is deferred by one microtask (see createBufferedSyncParams).
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(collection)).toEqual(['live']);

    // Fallback polling is over and mutations hand txids back to Electric.
    const fallbackCalls = vi.mocked(makeRequest).mock.calls.length;
    await vi.advanceTimersByTimeAsync(FALLBACK_REFRESH_INTERVAL_MS * 2);
    expect(vi.mocked(makeRequest).mock.calls.length).toBe(fallbackCalls);
    await expect(
      onUpdate({ transaction: { mutations: [{ key: 'live', changes: {} }] } })
    ).resolves.toEqual({ txid: [7] });

    // The probe session is now the live stream.
    emitChange(probe, 'insert', row('more'));
    expect(ids(collection)).toEqual(['live', 'more']);

    subscription.unsubscribe();
    expect(sessionsFor(id)).toHaveLength(2);
  });

  it('backs off between failed probes', async () => {
    const p = params();
    const { subscription } = await enterFallback(p);
    const id = `issues-${p.project_id}`;

    await vi.advanceTimersByTimeAsync(ELECTRIC_PROBE_BASE_DELAY_MS);
    expect(sessionsFor(id)).toHaveLength(2);
    const firstProbe = lastSessionFor(id);
    await vi.advanceTimersByTimeAsync(ELECTRIC_READY_TIMEOUT_MS);
    expect(firstProbe.cleanup).toHaveBeenCalledTimes(1);

    // Second probe waits twice as long.
    await vi.advanceTimersByTimeAsync(ELECTRIC_PROBE_BASE_DELAY_MS);
    expect(sessionsFor(id)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(ELECTRIC_PROBE_BASE_DELAY_MS);
    expect(sessionsFor(id)).toHaveLength(3);

    subscription.unsubscribe();
  });

  it('probes immediately on a manual retry', async () => {
    const p = params();
    const { collection, subscription } = await enterFallback(p);
    const id = `issues-${p.project_id}`;

    retryShapeSource(collection);
    expect(sessionsFor(id)).toHaveLength(2);

    subscription.unsubscribe();
  });
});
