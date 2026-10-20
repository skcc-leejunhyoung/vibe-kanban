import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';

const api = vi.hoisted(() => ({
  get: vi.fn(async () => ({ id: 'pane-ws', archived: false })),
  getRepos: vi.fn(async () => []),
  getDevServers: vi.fn(async () => []),
  getBranchStatus: vi.fn(async () => []),
  startDevServer: vi.fn(async () => undefined),
}));
const chrome = vi.hoisted(() => ({
  target: null as { workspaceId: string; hostId: string | null } | null,
}));

vi.mock('@/shared/lib/api', () => ({
  workspacesApi: api,
  executionProcessesApi: { stopExecutionProcess: vi.fn() },
}));
// The document route still points at the previously active pane's host.
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => 'doc-host',
}));
vi.mock('@/shared/lib/openInSplitPane', () => ({
  useChromeTargetWorkspace: () => chrome.target,
}));
vi.mock('@/shared/hooks/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    workspace: undefined,
    workspaceId: 'doc-ws',
    isCreateMode: false,
    repos: [],
  }),
}));
vi.mock('@/shared/hooks/useExecutionProcessesContext', async (original) => ({
  ...(await original<object>()),
  useExecutionProcessesContext: () => ({ isAttemptRunningVisible: false }),
}));
vi.mock('@/shared/stores/useUiPreferencesStore', () => ({
  useWorkspacePanelState: () => ({}),
}));
vi.mock('@/shared/stores/useDiffViewStore', () => ({
  useDiffViewMode: () => 'unified',
}));
vi.mock('@/shared/stores/useWorkspaceDiffStore', () => ({
  useDiffPaths: () => new Set(),
}));
vi.mock('@/shared/hooks/useUserSystem', () => ({
  useUserSystem: () => ({ config: null }),
}));
vi.mock('@/shared/integrations/electric/hooks', () => ({
  useShape: () => ({ data: [] }),
}));
vi.mock('@/shared/hooks/useLogsPanel', () => ({
  useLogsPanel: () => ({ logsPanelContent: null }),
}));
vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({ isSignedIn: true }),
}));
vi.mock('@/shared/lib/routes/appNavigation', () => ({
  isProjectDestination: () => false,
}));
vi.mock('@/shared/hooks/useCurrentAppDestination', () => ({
  useCurrentAppDestination: () => null,
}));
vi.mock('@/shared/hooks/useCurrentKanbanRouteState', () => ({
  useCurrentKanbanRouteState: () => ({ isCreateMode: false }),
}));
vi.mock('shared/remote-types', () => ({ PROJECT_ISSUES_SHAPE: {} }));
vi.mock('@/shared/hooks/useAppRuntime', () => ({
  useAppRuntime: () => 'local',
}));
vi.mock('@/shared/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

const { useActionVisibilityContext } = await import(
  './useActionVisibilityContext'
);
const { useDevServer } = await import('./useDevServer');

let dom: ReturnType<typeof installDomlessReact>;
let queryClient: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  dom = installDomlessReact();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(async () => {
  await dom.unmount();
  queryClient.clear();
  chrome.target = null;
});

async function render(node: ReactNode) {
  await dom.render(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function VisibilityProbe() {
  useActionVisibilityContext();
  return null;
}

describe('document chrome targeting a pane on another host', () => {
  it.each([
    ['a relay host', 'pane-host'],
    ['the local host', null],
  ])('reads the pane workspace from %s', async (_label, paneHostId) => {
    chrome.target = { workspaceId: 'pane-ws', hostId: paneHostId };
    await render(<VisibilityProbe />);

    for (const fn of [
      api.get,
      api.getRepos,
      api.getDevServers,
      api.getBranchStatus,
    ]) {
      expect(fn).toHaveBeenCalled();
      expect(fn.mock.calls).toEqual(
        fn.mock.calls.map(() => ['pane-ws', paneHostId])
      );
    }
  });

  it('keeps the document host without a chrome target', async () => {
    await render(<VisibilityProbe />);

    expect(api.getBranchStatus).toHaveBeenCalledWith('doc-ws', 'doc-host');
    expect(api.getDevServers).toHaveBeenCalledWith('doc-ws', 'doc-host');
    expect(api.getRepos).not.toHaveBeenCalled();
  });

  it('starts the dev server on the pane host', async () => {
    let start: (() => void) | undefined;
    function StartProbe() {
      ({ start } = useDevServer('pane-ws', { hostId: 'pane-host' }));
      return null;
    }
    await render(<StartProbe />);
    await act(async () => start?.());

    expect(api.startDevServer).toHaveBeenCalledWith('pane-ws', 'pane-host');
  });
});
