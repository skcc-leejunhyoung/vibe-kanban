import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairedRelayHost } from './relayPairingStorage';

// Async IDB boundary double: reads can be delayed past a committed write.
function database() {
  const rows = new Map<string, PairedRelayHost>();
  let delayReads = false;
  const reads: (() => void)[] = [];
  const close = vi.fn();
  const open = vi.fn(() => {
    const request = {
      result: { close, transaction },
      onsuccess: () => {},
      onerror: () => {},
      error: new Error('open failed'),
    };
    queueMicrotask(() => request.onsuccess());
    return request;
  });
  function transaction() {
    let pending = 0;
    const tx = {
      objectStore: () => store,
      oncomplete: () => {},
      onerror: () => {},
      onabort: () => {},
    };
    function operation<T>(action: () => T, read = false) {
      pending++;
      const result = {
        result: action(),
        onsuccess: () => {},
        onerror: () => {},
      };
      const finish = () => {
        result.onsuccess();
        queueMicrotask(() => {
          if (--pending === 0) tx.oncomplete();
        });
      };
      if (read && delayReads) reads.push(finish);
      else queueMicrotask(finish);
      return result;
    }
    const store = {
      getAll: () =>
        operation(
          () => [...rows.values()].map((row) => structuredClone(row)),
          true
        ),
      getAllKeys: () => operation(() => [...rows.keys()]),
      put: (row: PairedRelayHost) =>
        operation(() => rows.set(row.host_id, row)),
      delete: (id: string) => operation(() => rows.delete(id)),
      clear: () => operation(() => rows.clear()),
    };
    return tx;
  }
  return {
    open,
    rows,
    close,
    reads,
    delay: () => {
      delayReads = true;
    },
    resume: () => {
      delayReads = false;
      reads.splice(0).forEach((read) => read());
    },
  };
}

const host = (id: string): PairedRelayHost => ({
  host_id: id,
  host_name: id,
  public_key_b64: 'public',
  server_public_key_b64: 'server',
  paired_at: '2026-09-15',
  signing_session_id: 'session',
});
let db: ReturnType<typeof database>;
let channels: {
  onmessage?: (event: { data: unknown }) => void;
  postMessage: ReturnType<typeof vi.fn>;
}[];

beforeEach(() => {
  vi.resetModules();
  db = database();
  channels = [];
  vi.stubGlobal('indexedDB', db);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), { visibilityState: 'visible' })
  );
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      onmessage?: (event: { data: unknown }) => void;
      postMessage = vi.fn((data: unknown) => {
        for (const other of channels)
          if (other !== this) other.onmessage?.({ data });
      });
      constructor() {
        channels.push(this);
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pairing cache', () => {
  it('opens IDB once for 100 cold concurrent requests and keeps the result reference', async () => {
    db.rows.set('a', host('a'));
    const storage = await import('./relayPairingStorage');
    const results = await Promise.all(
      Array.from({ length: 100 }, () => storage.listPairedRelayHosts())
    );
    expect(db.open).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect(await storage.listPairedRelayHosts()).toBe(results[0]);
    expect(storage.relayPairingRefetchInterval()).toBe(60_000);
    console.log(
      '100 cold pairing lookups: IDB opens =',
      db.open.mock.calls.length
    );
  });

  it('invalidates save/remove/clear in both tabs without rebroadcasting or sending keys', async () => {
    const first = await import('./relayPairingStorage');
    vi.resetModules();
    const second = await import('./relayPairingStorage');
    const changed = vi.fn();
    second.subscribeRelayPairingChanges(changed);
    await Promise.all([
      first.listPairedRelayHosts(),
      second.listPairedRelayHosts(),
    ]);
    await first.savePairedRelayHost(host('a'));
    expect(await second.listPairedRelayHosts()).toEqual([host('a')]);
    expect(await first.listPairedRelayHosts()).toEqual([host('a')]);
    await first.removePairedRelayHost('a');
    expect(await second.listPairedRelayHosts()).toEqual([]);
    await first.savePairedRelayHost(host('b'));
    await second.listPairedRelayHosts();
    await first.clearPairedRelayHosts();
    expect(await second.listPairedRelayHosts()).toEqual([]);
    expect(changed.mock.calls.map(([change]) => change)).toEqual([
      { hostId: 'a', type: 'saved' },
      { hostId: 'a', type: 'removed' },
      { hostId: 'b', type: 'saved' },
      { hostId: 'b', type: 'removed' },
    ]);
    expect(channels[0].postMessage).not.toHaveBeenCalled();
    expect(
      channels[1].postMessage.mock.calls.every(
        ([data]) => Object.keys(data).sort().join() === 'hostId,type'
      )
    ).toBe(true);
  });

  it('discards a stale read overtaken by removal and shares the replacement read', async () => {
    db.rows.set('a', host('a'));
    const storage = await import('./relayPairingStorage');
    db.delay();
    const first = storage.listPairedRelayHosts();
    await Promise.resolve();
    await storage.removePairedRelayHost('a');
    const second = storage.listPairedRelayHosts();
    await Promise.resolve();
    db.resume();
    expect(await first).toEqual([]);
    expect(await first).toBe(await second);
    expect(db.open).toHaveBeenCalledTimes(3); // old read + write + new read
  });

  it('retries a failed cold read', async () => {
    const storage = await import('./relayPairingStorage');
    db.open.mockImplementationOnce(() => {
      const request = { onerror: () => {}, error: new Error('open failed') };
      queueMicrotask(() => request.onerror());
      return request as ReturnType<typeof db.open>;
    });
    await expect(storage.listPairedRelayHosts()).rejects.toThrow('open failed');
    expect(await storage.listPairedRelayHosts()).toEqual([]);
    expect(db.open).toHaveBeenCalledTimes(2);
  });

  it('reconciles a missed broadcast on visibility/BFCache resume', async () => {
    db.rows.set('a', host('a'));
    const storage = await import('./relayPairingStorage');
    await storage.listPairedRelayHosts();
    const changed = vi.fn();
    storage.subscribeRelayPairingChanges(changed);
    db.rows.delete('a');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await storage.listPairedRelayHosts()).toEqual([]);
    expect(changed).toHaveBeenCalledWith({ hostId: 'a', type: 'saved' });
    db.rows.set('b', host('b'));
    window.dispatchEvent(
      Object.assign(new Event('pageshow'), { persisted: true })
    );
    expect(await storage.listPairedRelayHosts()).toEqual([host('b')]);
  });

  it('shares even a slow cold read past the fallback TTL', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.useFakeTimers();
    const storage = await import('./relayPairingStorage');
    db.delay();
    const first = storage.listPairedRelayHosts();
    await vi.advanceTimersByTimeAsync(60_001);
    const second = storage.listPairedRelayHosts();
    expect(second).toBe(first);
    db.resume();
    expect(await second).toEqual([]);
    expect(db.open).toHaveBeenCalledTimes(1);
  });

  it('bounds stale pairings to 60 seconds without a cross-tab channel', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.useFakeTimers();
    const storage = await import('./relayPairingStorage');
    expect(storage.relayPairingRefetchInterval()).toBe(60_000);
    expect(await storage.listPairedRelayHosts()).toEqual([]);
    db.rows.set('a', host('a'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await storage.listPairedRelayHosts()).toEqual([host('a')]);
  });
});

vi.mock('@/shared/hooks/useAppRuntime', () => ({
  useAppRuntime: () => 'remote',
}));
vi.mock('@/shared/hooks/useRemoteCloudHosts', () => ({
  useRemoteCloudHostsState: () => ({ data: undefined }),
}));
vi.mock('@/shared/lib/remoteApi', () => ({
  listRelayHosts: async () => [{ id: 'a', name: 'Host A', status: 'online' }],
}));

it.each(['notified', 'failed-refetch', 'legacy'])(
  'keeps idle host lists stable and handles %s removal',
  async (mode) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.assign(document, { nodeType: 9, activeElement: null });
    Object.assign(window, {
      document,
      setTimeout,
      clearTimeout,
      HTMLIFrameElement: class {},
    });
    const root = createRoot(
      Object.assign(new EventTarget(), {
        nodeType: 1,
        tagName: 'DIV',
        ownerDocument: document,
      }) as unknown as HTMLElement
    );
    const { QueryClient, QueryClientProvider } = await import(
      '@tanstack/react-query'
    );
    const { useWorkspaceHostOptions } = await import(
      '../hooks/useWorkspaceHostOptions'
    );
    const { useRelayAppBarHosts } = await import(
      '../../../../remote-web/src/shared/hooks/useRelayAppBarHosts'
    );
    const { privateKey } = (await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    db.rows.set('a', { ...host('a'), private_key: privateKey });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 3, retryDelay: 1 } },
    });
    const renders = { picker: 0, appBar: 0 };
    let pickerIds: string[] = [];
    let appBarIds: string[] = [];
    function Picker() {
      pickerIds = useWorkspaceHostOptions().hosts.map((host) => host.id);
      renders.picker++;
      return null;
    }
    function AppBar() {
      appBarIds = useRelayAppBarHosts(true).hosts.map((host) => host.id);
      renders.appBar++;
      return null;
    }
    try {
      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(Picker),
            createElement(AppBar)
          )
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(pickerIds).toEqual(['a']);
      expect(appBarIds).toEqual(['a']);
      const before = { ...renders };
      const opens = db.open.mock.calls.length;
      for (let i = 0; i < 12; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
      }
      console.log(
        '60s idle: picker/app-bar renders, IDB opens =',
        renders.picker - before.picker,
        renders.appBar - before.appBar,
        db.open.mock.calls.length - opens
      );
      expect(renders).toEqual(before);
      expect(db.open).toHaveBeenCalledTimes(opens + 1);
      await act(async () => {
        db.rows.delete('a');
        if (mode === 'failed-refetch') {
          const failRead = () => {
            const request = {
              onerror: () => {},
              error: new Error('IDB temporarily unavailable'),
            };
            queueMicrotask(() => request.onerror());
            return request as ReturnType<typeof db.open>;
          };
          for (let i = 0; i < 4; i++) db.open.mockImplementationOnce(failRead);
        }
        if (mode !== 'legacy') {
          channels[0].onmessage?.({ data: { hostId: 'a', type: 'removed' } });
        }
        await vi.advanceTimersByTimeAsync(mode === 'legacy' ? 60_000 : 50);
      });
      expect(pickerIds).toEqual([]);
      expect(appBarIds).toEqual([]);
      if (mode === 'legacy') {
        await act(async () => {
          db.rows.set('a', host('a'));
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(pickerIds).toEqual(['a']);
        expect(appBarIds).toEqual(['a']);
      }
      const storage = await import('./relayPairingStorage');
      await act(async () => {
        await storage.savePairedRelayHost(host('a'));
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(pickerIds).toEqual(['a']);
      expect(appBarIds).toEqual(['a']);
      await act(async () => {
        await storage.removePairedRelayHost('a');
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(pickerIds).toEqual([]);
      expect(appBarIds).toEqual([]);
      if (mode === 'notified') {
        await act(async () => {
          await storage.savePairedRelayHost(host('a'));
          await vi.advanceTimersByTimeAsync(1);
        });
        await act(() =>
          root.render(createElement(QueryClientProvider, { client }))
        );
        db.rows.delete('a');
        channels[0].onmessage?.({ data: { hostId: 'a', type: 'removed' } });
        await act(() =>
          root.render(
            createElement(
              QueryClientProvider,
              { client },
              createElement(Picker),
              createElement(AppBar)
            )
          )
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        expect(pickerIds).toEqual([]);
        expect(appBarIds).toEqual([]);
      }
    } finally {
      await act(() => root.unmount());
      client.clear();
    }
  }
);

it('reconciles pre-upgrade window changes and notifies auth caches only for changed credentials', async () => {
  vi.useFakeTimers();
  db.rows.set('a', host('a'));
  const storage = await import('./relayPairingStorage');
  await storage.listPairedRelayHosts();
  const changed = vi.fn();
  storage.subscribeRelayPairingChanges(changed);
  await vi.advanceTimersByTimeAsync(60_000);
  await storage.listPairedRelayHosts();
  expect(changed).not.toHaveBeenCalled();
  db.rows.set('a', {
    ...host('a'),
    public_key_b64: 'new-key',
    signing_session_id: 'new-session',
  });
  await vi.advanceTimersByTimeAsync(60_000);
  const refreshed = await Promise.all(
    Array.from({ length: 100 }, () => storage.listPairedRelayHosts())
  );
  expect(db.open).toHaveBeenCalledTimes(3);
  expect(refreshed.every((hosts) => hosts === refreshed[0])).toBe(true);
  expect(refreshed[0][0].signing_session_id).toBe('new-session');
  db.rows.delete('a');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await storage.listPairedRelayHosts()).toEqual([]);
  expect(changed.mock.calls.map(([change]) => change)).toEqual([
    { hostId: 'a', type: 'saved' },
    { hostId: 'a', type: 'removed' },
  ]);
  expect(channels[0].postMessage).not.toHaveBeenCalled();
});

it('shares forced reconciliation without letting a warm request cache postpone it', async () => {
  const storage = await import('./relayPairingStorage');
  db.rows.set('a', host('a'));
  await storage.listPairedRelayHosts();
  db.rows.delete('a');
  const results = await Promise.all(
    Array.from({ length: 100 }, () => storage.listPairedRelayHosts(true))
  );
  expect(
    results.every((hosts) => hosts.length === 0 && hosts === results[0])
  ).toBe(true);
  expect(db.open).toHaveBeenCalledTimes(2);
});
