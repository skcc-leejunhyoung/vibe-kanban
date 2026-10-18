import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSummary, WorkspaceWithStatus } from 'shared/types';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import { workspaceSummaryKeys } from './workspaceSummaryKeys';
import {
  combineRemoteWorkspaceStreams,
  fetchWorkspaceSummaries,
  getHostWorkspaceKey,
  resolveOnlineWorkspaceStreamHostIds,
  resolveSnapshotHostIds,
  useWorkspaces,
  type SidebarWorkspace,
  type UseWorkspacesResult,
} from './useWorkspaces';

vi.mock('@/shared/lib/localApiTransport', () => ({
  makeLocalApiRequest: vi.fn(),
}));
vi.mock('@/shared/hooks/useJsonPatchWsStream', () => ({
  useJsonPatchWsStream: vi.fn(),
}));

describe('combined workspace summaries', () => {
  it.each([
    [{}, { archived: null, include_latest_prompt: true }],
    [{ archived: false }, { archived: false, include_latest_prompt: true }],
    [
      { archived: true, includeLatestPrompt: false },
      { archived: true, include_latest_prompt: false },
    ],
  ] as const)('sends filter %o as %o', async (options, body) => {
    const request = vi.mocked(makeLocalApiRequest);
    request.mockReset();
    const summaries = [
      { workspace_id: 'active', todo_total: 3 },
    ] as WorkspaceSummary[];
    request.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { summaries } }))
    );

    const map = await fetchWorkspaceSummaries('remote-host', options);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      '/api/workspaces/summaries',
      expect.objectContaining({
        body: JSON.stringify(body),
        hostScope: 'explicit',
        hostId: 'remote-host',
        relayHostId: 'remote-host',
      })
    );
    expect(map.get('active')?.todo_total).toBe(3);
    expect(workspaceSummaryKeys.byHost('host-a')).not.toEqual(
      workspaceSummaryKeys.byHost('host-b')
    );
    expect(workspaceSummaryKeys.archivedByHost('host-a')).not.toEqual(
      workspaceSummaryKeys.byHost('host-a')
    );
  });

  it.each([null, 'legacy-host'])(
    'falls back to boolean filters only for an older host %s',
    async (hostId) => {
      const request = vi.mocked(makeLocalApiRequest);
      request.mockReset();
      request.mockImplementation(async (_path, options) => {
        const { archived } = JSON.parse(options?.body as string);
        if (archived === null) {
          return new Response('invalid type: null, expected a boolean', {
            status: 422,
          });
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              summaries: [
                {
                  workspace_id: archived ? 'archived' : 'active',
                  todo_total: 3,
                },
              ],
            },
          })
        );
      });

      const map = await fetchWorkspaceSummaries(hostId, {
        includeLatestPrompt: false,
      });
      expect([...map.keys()]).toEqual(['active', 'archived']);
      expect(request).toHaveBeenCalledTimes(3);
      expect(
        request.mock.calls.map(([, options]) =>
          JSON.parse(options?.body as string)
        )
      ).toEqual([
        { archived: null, include_latest_prompt: false },
        { archived: false, include_latest_prompt: false },
        { archived: true, include_latest_prompt: false },
      ]);
      for (const [, options] of request.mock.calls) {
        expect(options).toMatchObject({
          hostScope: 'explicit',
          hostId,
          relayHostId: hostId,
        });
      }
    }
  );

  it.each([401, 403, 500])(
    'does not retry non-schema error %s',
    async (status) => {
      const request = vi.mocked(makeLocalApiRequest);
      request.mockReset();
      request.mockResolvedValue(new Response(null, { status }));
      expect((await fetchWorkspaceSummaries('failed-host')).size).toBe(0);
      expect(request).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps the other legacy list when one request fails without retrying again', async () => {
    const request = vi.mocked(makeLocalApiRequest);
    for (const failure of [
      new Response(null, { status: 422 }),
      new Error('offline'),
    ]) {
      request.mockReset();
      request.mockResolvedValueOnce(new Response(null, { status: 422 }));
      if (failure instanceof Error) request.mockRejectedValueOnce(failure);
      else request.mockResolvedValueOnce(failure);
      request.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: { summaries: [{ workspace_id: 'archived' }] },
          })
        )
      );
      expect([
        ...(await fetchWorkspaceSummaries('legacy-host')).keys(),
      ]).toEqual(['archived']);
      expect(request).toHaveBeenCalledTimes(3);
    }
  });
});

describe('resolveOnlineWorkspaceStreamHostIds', () => {
  const hosts = [
    { id: 'host-a', status: 'online' },
    { id: 'host-b', status: 'offline' },
  ];

  it('returns no host endpoints when PR-only mode disables streams', () => {
    expect(resolveOnlineWorkspaceStreamHostIds(hosts, false)).toEqual([]);
  });

  it('returns only online hosts when a workspace pane needs streams', () => {
    expect(resolveOnlineWorkspaceStreamHostIds(hosts, true)).toEqual([
      'host-a',
    ]);
  });
});

function sidebarWorkspace(id: string, hostId: string): SidebarWorkspace {
  return {
    id,
    name: id,
    branch: 'develop',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    description: '',
    hostId,
  };
}

function hostResult(
  hostId: string,
  activeIds: string[],
  archivedIds: string[] = []
): UseWorkspacesResult {
  const workspaces = activeIds.map((id) => sidebarWorkspace(id, hostId));
  const archivedWorkspaces = archivedIds.map((id) => ({
    ...sidebarWorkspace(id, hostId),
    isArchived: true,
  }));
  const workspaceRecordsById = Object.fromEntries(
    [...activeIds, ...archivedIds].map((id) => [
      getHostWorkspaceKey(id, hostId),
      { id } as WorkspaceWithStatus,
    ])
  );

  return {
    workspaces,
    archivedWorkspaces,
    workspaceRecordsById,
    isLoading: false,
    isArchivedLoading: false,
    isConnected: true,
    error: null,
  };
}

describe('combineRemoteWorkspaceStreams', () => {
  it('combines each online host stream exactly once', () => {
    const result = combineRemoteWorkspaceStreams(
      new Map([
        ['host-a', hostResult('host-a', ['a-1'], ['a-2'])],
        ['host-b', hostResult('host-b', ['b-1'])],
      ]),
      ['host-a', 'host-b']
    );

    expect(result.workspaces.map(({ id, hostId }) => [id, hostId])).toEqual([
      ['a-1', 'host-a'],
      ['b-1', 'host-b'],
    ]);
    expect(
      result.archivedWorkspaces.map(({ id, hostId }) => [id, hostId])
    ).toEqual([['a-2', 'host-a']]);
    expect(Object.keys(result.workspaceRecordsById)).toEqual([
      'host-a:a-1',
      'host-a:a-2',
      'host-b:b-1',
    ]);
  });

  it('keeps identical workspace IDs isolated by host', () => {
    const result = combineRemoteWorkspaceStreams(
      new Map([
        ['host-a', hostResult('host-a', ['same-id'])],
        ['host-b', hostResult('host-b', ['same-id'])],
      ]),
      ['host-a', 'host-b']
    );

    expect(Object.keys(result.workspaceRecordsById)).toEqual([
      'host-a:same-id',
      'host-b:same-id',
    ]);
  });

  it('waits for every online host stream to finish its initial snapshot', () => {
    const loadingHost = {
      ...hostResult('host-b', []),
      isLoading: true,
      isConnected: false,
    };
    const result = combineRemoteWorkspaceStreams(
      new Map([
        ['host-a', hostResult('host-a', ['a-1'])],
        ['host-b', loadingHost],
      ]),
      ['host-a', 'host-b']
    );

    expect(result.isLoading).toBe(true);
    expect(result.isConnected).toBe(false);
  });

  it('does not stay loading when there are no online hosts', () => {
    const result = combineRemoteWorkspaceStreams(new Map(), []);

    expect(result.isLoading).toBe(false);
    expect(result.isConnected).toBe(false);
    expect(result.workspaces).toEqual([]);
  });

  it('shows active rows while a host archive is still loading', () => {
    const result = combineRemoteWorkspaceStreams(
      new Map([
        ['host-a', hostResult('host-a', ['a-1'])],
        [
          'host-b',
          { ...hostResult('host-b', ['b-1']), isArchivedLoading: true },
        ],
      ]),
      ['host-a', 'host-b']
    );

    expect(result.isLoading).toBe(false);
    expect(result.isArchivedLoading).toBe(true);
    expect(result.workspaces.map(({ id }) => id)).toEqual(['a-1', 'b-1']);
  });

  it('stays loading until every online host has registered its stream', () => {
    const result = combineRemoteWorkspaceStreams(
      new Map([['host-a', hostResult('host-a', ['a-1'])]]),
      ['host-a', 'host-b']
    );

    expect(result.isLoading).toBe(true);
  });
});

describe('resolveSnapshotHostIds', () => {
  it('snapshots every online remote host when the route is on the local machine', () => {
    // /workspaces route: local machine owns the live `current` stream.
    expect(resolveSnapshotHostIds(['i9', 'other'], null)).toEqual([
      'i9',
      'other',
    ]);
  });

  it('adds the local machine as a snapshot when the route is on a remote host', () => {
    // /hosts/i9/... route: i9 owns `current`, so it is excluded and the local
    // machine (null) must be pulled in so its workspaces stay visible.
    expect(resolveSnapshotHostIds(['i9'], 'i9')).toEqual([null]);
  });

  it('excludes the route host but keeps other remote hosts and the local machine', () => {
    expect(resolveSnapshotHostIds(['i9', 'other'], 'i9')).toEqual([
      'other',
      null,
    ]);
  });
});

describe('sidebar reference and ordering cache', () => {
  it('preserves unchanged rows across status/summary patches, sorting ties, pinning and host changes', async () => {
    const { createSidebarWorkspaceList, toSidebarWorkspace } = await import(
      './useWorkspaces'
    );
    const select = createSidebarWorkspaceList();
    const record = (id: string, createdAt: string, pinned = false) =>
      ({
        id,
        name: id,
        branch: id,
        created_at: createdAt,
        updated_at: createdAt,
        pinned,
        archived: false,
        is_running: false,
      }) as WorkspaceWithStatus;
    const records = {
      a: record('a', '2026-09-01T00:00:00Z'),
      b: record('b', '2026-09-02T00:00:00Z'),
      c: record('c', '2026-09-02T00:00:00Z'),
    };
    const summaries = new Map();
    const original = select(records, summaries, null);
    expect(original.map((row) => row.id)).toEqual(['b', 'c', 'a']);
    const patched = select(
      { ...records, a: { ...records.a, is_running: true } },
      summaries,
      null
    );
    expect(patched[0]).toBe(original[0]);
    expect(patched[1]).toBe(original[1]);
    expect(patched[2]).not.toBe(original[2]);
    const pinned = select(
      { ...records, a: { ...records.a, pinned: true } },
      summaries,
      null
    );
    expect(pinned.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    const reordered = select(
      { c: records.c, b: records.b, a: records.a },
      summaries,
      null
    );
    expect(reordered.map((row) => row.id)).toEqual(['c', 'b', 'a']);
    const remote = select(records, summaries, 'host-b');
    expect(remote.every((row) => row.hostId === 'host-b')).toBe(true);
    expect(remote[0]).not.toBe(original[0]);
    const summary = {
      files_changed: 3,
    } as import('shared/types').WorkspaceSummary;
    const withSummary = toSidebarWorkspace(records.a, summary, 'host-b');
    expect(toSidebarWorkspace(records.a, summary, 'host-b')).toBe(withSummary);
    expect(
      toSidebarWorkspace(records.a, { ...summary, files_changed: 4 }, 'host-b')
        .filesChanged
    ).toBe(4);
    expect(select({}, summaries, null)).toEqual([]);
  });
});

describe('SKC-4780 host caches', () => {
  it('reuses a merged result for unchanged streams and equivalent host ids', () => {
    const streams = new Map([['a', hostResult('a', ['one'])]]);
    expect(combineRemoteWorkspaceStreams(streams, ['a'])).toBe(
      combineRemoteWorkspaceStreams(streams, ['a'])
    );
    expect(combineRemoteWorkspaceStreams(streams, []).workspaces).toEqual([]);
  });
});

describe('useWorkspaces active-first loading', () => {
  const ACTIVE = '/api/workspaces/streams/ws?archived=false';
  const ARCHIVED = '/api/workspaces/streams/ws?archived=true';
  let streams: Record<
    string,
    { workspaces: Record<string, WorkspaceWithStatus> } | undefined
  >;
  let enabledByEndpoint: Record<string, boolean>;
  let result: UseWorkspacesResult;
  let root: Root;
  let queryClient: QueryClient;

  const row = (id: string, archived: boolean) =>
    ({
      id,
      archived,
      created_at: '2026-10-18T00:00:00Z',
    }) as WorkspaceWithStatus;
  const summaryBodies = () =>
    vi
      .mocked(makeLocalApiRequest)
      .mock.calls.map(([, options]) => JSON.parse(options?.body as string));
  function Probe() {
    result = useWorkspaces();
    return null;
  }
  const render = () =>
    act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe)
        )
      );
    });

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const document = Object.assign(new EventTarget(), {
      nodeType: 9,
      activeElement: null,
    });
    vi.stubGlobal('document', document);
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        document,
        event: undefined,
        setTimeout,
        clearTimeout,
        HTMLIFrameElement: class {},
      })
    );
    root = createRoot(
      Object.assign(new EventTarget(), {
        nodeType: 1,
        tagName: 'DIV',
        ownerDocument: document,
      }) as unknown as HTMLElement
    );
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    streams = {};
    enabledByEndpoint = {};
    vi.mocked(useJsonPatchWsStream).mockImplementation(((
      endpoint: string,
      enabled: boolean
    ) => {
      enabledByEndpoint[endpoint] = enabled;
      const data = enabled ? streams[endpoint] : undefined;
      return {
        data,
        isConnected: !!data,
        isInitialized: !!data,
        error: null,
        reconcile: () => {},
        flush: () => {},
      };
    }) as typeof useJsonPatchWsStream);
    const request = vi.mocked(makeLocalApiRequest);
    request.mockReset();
    request.mockImplementation(async (_path, options) => {
      const { archived } = JSON.parse(options?.body as string);
      const summaries = archived
        ? [{ workspace_id: 'z1', has_unseen_turns: true }]
        : [{ workspace_id: 'a1', todo_total: 2 }];
      return new Response(
        JSON.stringify({ success: true, data: { summaries } })
      );
    });
  });

  afterEach(async () => {
    await act(() => root.unmount());
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it('renders active rows before the archive and fetches each list once', async () => {
    await render();
    expect(result.isLoading).toBe(true);
    expect(enabledByEndpoint[ARCHIVED]).toBe(false);
    expect(summaryBodies()).toEqual([]);

    streams[ACTIVE] = { workspaces: { a1: row('a1', false) } };
    await render();
    expect(result.isLoading).toBe(false);
    expect(result.isArchivedLoading).toBe(true);
    expect(enabledByEndpoint[ARCHIVED]).toBe(true);
    await vi.waitFor(() => expect(result.workspaces[0].todoTotal).toBe(2));
    expect(summaryBodies()).toEqual([
      { archived: false, include_latest_prompt: true },
    ]);

    streams[ARCHIVED] = { workspaces: { z1: row('z1', true) } };
    await render();
    expect(result.isArchivedLoading).toBe(false);
    await vi.waitFor(() =>
      expect(result.archivedWorkspaces[0].hasUnseenActivity).toBe(true)
    );
    expect(summaryBodies().slice(1)).toEqual([
      { archived: true, include_latest_prompt: false },
    ]);
  });

  it('refetches archived summaries only when an id is archived in', async () => {
    streams[ACTIVE] = { workspaces: { a1: row('a1', false) } };
    streams[ARCHIVED] = { workspaces: { z1: row('z1', true) } };
    await render();
    await render();
    const archivedFetches = () =>
      summaryBodies().filter((body) => body.archived).length;
    await vi.waitFor(() => expect(archivedFetches()).toBe(1));

    streams[ARCHIVED] = {
      workspaces: { z1: row('z1', true), z2: row('z2', true) },
    };
    await render();
    await vi.waitFor(() => expect(archivedFetches()).toBe(2));

    streams[ARCHIVED] = { workspaces: { z1: row('z1', true) } };
    await render();
    await act(async () => {});
    expect(archivedFetches()).toBe(2);
  });
});
