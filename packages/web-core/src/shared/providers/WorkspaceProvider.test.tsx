import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceContext,
  useWorkspaceContext,
  type WorkspaceContextValue,
} from '@/shared/hooks/useWorkspaceContext';
import { useWorkspaceRecord } from '@/shared/hooks/useWorkspaceRecord';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { HostIdContext } from './HostIdProvider';
import { WorkspaceProvider } from './WorkspaceProvider';

vi.mock('@/shared/hooks/useAppNavigation', () => ({
  useAppNavigation: () => ({}),
}));
vi.mock('@/shared/hooks/useCurrentAppDestination', () => ({
  useCurrentAppDestination: () => ({
    kind: 'workspace',
    workspaceId: 'workspace-a',
  }),
}));
vi.mock('@/shared/hooks/useWorkspaceRecord', () => ({
  useWorkspaceRecord: vi.fn(),
}));
vi.mock('@/shared/hooks/useWorkspaceSessions', () => ({
  useWorkspaceSessions: () => ({ sessions: [] }),
}));
vi.mock('@/shared/hooks/useWorkspaceRepo', () => ({
  useWorkspaceRepo: () => ({ repos: [], isLoading: false }),
}));
vi.mock('@/shared/hooks/useGitHubComments', () => ({
  useGitHubComments: () => ({}),
}));
vi.mock('@/shared/hooks/useDiffStream', () => ({
  useDiffStream: () => ({ diffs: [] }),
}));
vi.mock('@/shared/lib/api', () => ({
  workspacesApi: { markSeen: vi.fn(async () => {}) },
}));

let dom: ReturnType<typeof installDomlessReact>;
let client: QueryClient;
let latest: WorkspaceContextValue;
let mounts: number;
let unmounts: number;

beforeEach(() => {
  dom = installDomlessReact();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mounts = 0;
  unmounts = 0;
  vi.mocked(useWorkspaceRecord).mockReturnValue({
    data: { id: 'workspace-a' },
    isLoading: false,
    isError: false,
  } as ReturnType<typeof useWorkspaceRecord>);
});

afterEach(async () => {
  await dom.unmount();
  client.clear();
  vi.unstubAllGlobals();
});

function Conversation() {
  useEffect(() => {
    mounts++;
    return () => {
      unmounts++;
    };
  }, []);
  return null;
}

function Pane() {
  latest = useWorkspaceContext();
  // WorkspacesMain removes the conversation while the workspace is loading.
  return latest.isLoading ? null : <Conversation />;
}

function renderPane(hostId: string | null, listLoading: boolean) {
  const parent = {
    activeWorkspaces: [],
    archivedWorkspaces: [],
    isWorkspacesListLoading: listLoading,
    isArchivedWorkspacesLoading: listLoading,
  } as unknown as WorkspaceContextValue;
  return dom.render(
    <QueryClientProvider client={client}>
      <WorkspaceContext.Provider value={parent}>
        <HostIdContext.Provider value={hostId}>
          <WorkspaceProvider inheritStreams>
            <Pane />
          </WorkspaceProvider>
        </HostIdContext.Provider>
      </WorkspaceContext.Provider>
    </QueryClientProvider>
  );
}

describe('WorkspaceProvider pane loading', () => {
  it.each([null, 'host-b'])(
    'keeps the %s host conversation mounted while the shared list reloads',
    async (hostId) => {
      await renderPane(hostId, false);
      expect(mounts).toBe(1);

      for (const loading of [true, false, true, false]) {
        await renderPane(hostId, loading);
        expect(latest.isWorkspacesListLoading).toBe(loading);
        expect(latest.isLoading).toBe(false);
        expect(unmounts).toBe(0);
        expect(mounts).toBe(1);
      }
    }
  );

  it('still waits for the pane workspace itself to load', async () => {
    vi.mocked(useWorkspaceRecord).mockReturnValueOnce({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useWorkspaceRecord>);

    await renderPane('host-b', false);
    expect(latest.isLoading).toBe(true);
    expect(mounts).toBe(0);

    await renderPane('host-b', true);
    expect(latest.isLoading).toBe(false);
    expect(latest.isWorkspacesListLoading).toBe(true);
    expect(mounts).toBe(1);
  });
});
