import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDestination } from '@/shared/lib/routes/appNavigation';
import { useWorkspaceArtifacts } from '@/features/workspace-chat/ui/WorkspaceArtifacts';
import { useWorkspaceArtifactLink } from './useWorkspaceArtifactLink';
import {
  useWorkspaceSessions,
  useWorkspaceSessionSelectionStore,
  selectWorkspaceSession,
} from './useWorkspaceSessions';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', new EventTarget());
  return {
    href: '',
    destination: null as AppDestination | null,
    hostId: null as string | null,
    self: { hostId: null as string | null, isPending: false },
    auth: { isLoaded: true, isSignedIn: true, userId: 'synthetic-account-a' },
    status: vi.fn(),
    list: vi.fn(),
  };
});
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ href: state.href }),
}));
vi.mock('@/shared/hooks/useAppNavigation', () => ({
  useAppNavigation: () => ({ resolveFromPath: () => state.destination }),
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => state.hostId,
}));
vi.mock('@/shared/hooks/useSelfCloudHostId', () => ({
  useSelfCloudHostId: () => state.self,
}));
vi.mock('@/shared/hooks/auth/useAuth', () => ({ useAuth: () => state.auth }));
vi.mock('@/shared/lib/api', () => ({
  ownedArtifactsApi: { transferStatus: state.status, list: state.list },
  sessionsApi: {
    getByWorkspace: async () => [{ id: 'a-latest' }, { id: 'a-older' }],
  },
}));
vi.mock('@/features/workspace-chat/ui/DrawerArtifact', () => ({
  DrawerArtifact: () => null,
}));

let root: Root;
let client: QueryClient;
let pane: ReturnType<typeof useWorkspaceSessions>;
let artifacts: ReturnType<typeof useWorkspaceArtifacts>;
const ready = {
  status: 'ready',
  source: { kind: 'workspace', workspace_id: 'ws-a', session_id: 'a-older' },
};
function Probe() {
  useWorkspaceArtifactLink('ws-a');
  pane = useWorkspaceSessions('ws-a');
  artifacts = useWorkspaceArtifacts('ws-a', pane.selectedSessionId);
  return null;
}
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
      else await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
async function render() {
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Probe))
    );
  });
  await settle();
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const document = Object.assign(new EventTarget(), {
    nodeType: 9,
    activeElement: null,
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} })
  );
  root = createRoot(
    Object.assign(new EventTarget(), {
      nodeType: 1,
      tagName: 'DIV',
      ownerDocument: document,
    }) as unknown as HTMLElement
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useWorkspaceSessionSelectionStore.setState({ selections: {} });
  state.hostId = null;
  state.self = { hostId: null, isPending: false };
  state.auth = {
    isLoaded: true,
    isSignedIn: true,
    userId: 'synthetic-account-a',
  };
  state.destination = { kind: 'workspace', workspaceId: 'ws-a' };
  state.href = '/workspaces/ws-a?artifact=synthetic-artifact';
  state.status.mockReset().mockResolvedValue(ready);
  state.list
    .mockReset()
    .mockImplementation(async (_workspace, session) =>
      session === 'a-older' ? [{ id: 'synthetic-artifact' }] : []
    );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([null, 'synthetic-remote-host'])(
  'opens the artifact owner session and lists its dashboard on host %s',
  async (hostId) => {
    state.hostId = hostId;
    state.destination = { kind: 'workspace', workspaceId: 'ws-a', hostId };
    await render();
    expect(pane.selectedSessionId).toBe('a-older');
    expect(artifacts.data).toEqual([{ id: 'synthetic-artifact' }]);
    expect(state.status).toHaveBeenCalledWith(
      'synthetic-artifact',
      hostId,
      expect.any(AbortSignal)
    );
    await act(async () => pane.selectSession('a-latest'));
    await render();
    expect(pane.selectedSessionId).toBe('a-latest');
  }
);

it('folds a local self-host link before selecting its session', async () => {
  state.destination = {
    kind: 'workspace',
    workspaceId: 'ws-a',
    hostId: 'synthetic-self-host',
  };
  state.self.hostId = 'synthetic-self-host';
  await render();
  expect(pane.selectedSessionId).toBe('a-older');
  expect(state.status).toHaveBeenCalledWith(
    'synthetic-artifact',
    null,
    expect.any(AbortSignal)
  );
});

it('leaves a normal workspace URL and its selected session alone', async () => {
  state.href = '/workspaces/ws-a';
  selectWorkspaceSession('ws-a', null, 'a-older');
  await render();
  expect(state.status).not.toHaveBeenCalled();
  expect(pane.selectedSessionId).toBe('a-older');
});

it('opens an explicit artifact link over a session selected before navigation', async () => {
  selectWorkspaceSession('ws-a', null, 'a-latest');
  await render();
  expect(pane.selectedSessionId).toBe('a-older');
});

it.each([
  { kind: 'workspace', workspaceId: 'ws-b' },
  { kind: 'workspace', workspaceId: 'ws-a', hostId: 'another-host' },
  { kind: 'drawer', noteId: 'synthetic-note' },
] as AppDestination[])(
  'does not act on another pane destination %o',
  async (destination) => {
    state.destination = destination;
    await render();
    expect(state.status).not.toHaveBeenCalled();
    expect(pane.selectedSessionId).toBe('a-latest');
  }
);

it.each([
  { kind: 'workspace', workspace_id: 'ws-b', session_id: 'b-older' },
  { kind: 'drawer', note_id: 'synthetic-note' },
])(
  'does not select a session when the current owner is elsewhere %o',
  async (source) => {
    state.status.mockResolvedValue({ status: 'ready', source });
    await render();
    expect(pane.selectedSessionId).toBe('a-latest');
  }
);

it('waits for a pending transfer, selects its committed owner and stops polling', async () => {
  vi.useFakeTimers();
  state.status
    .mockResolvedValueOnce({ ...ready, status: 'pending' })
    .mockResolvedValue(ready);
  await render();
  expect(pane.selectedSessionId).toBe('a-latest');
  await act(async () => vi.advanceTimersByTimeAsync(2100));
  await settle();
  expect(pane.selectedSessionId).toBe('a-older');
  await act(async () => pane.selectSession('a-latest'));
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(state.status).toHaveBeenCalledTimes(2);
  expect(pane.selectedSessionId).toBe('a-latest');
});

it('retries temporary failures but treats ownership denial as terminal', async () => {
  vi.useFakeTimers();
  state.status
    .mockRejectedValueOnce(
      Object.assign(new Error('Unavailable'), { statusCode: 503 })
    )
    .mockRejectedValue(
      Object.assign(new Error('Forbidden'), { statusCode: 403 })
    );
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(10100));
  await settle();
  expect(state.status).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(state.status).toHaveBeenCalledTimes(2);
  expect(pane.selectedSessionId).toBe('a-latest');
});

it.each(['route', 'account', 'logout'])(
  'ignores a late response after the %s changes',
  async (change) => {
    let resolve!: (value: typeof ready) => void;
    state.status
      .mockRejectedValue(
        Object.assign(new Error('Forbidden'), { statusCode: 403 })
      )
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
    await render();
    if (change === 'route') {
      state.destination = { kind: 'workspace', workspaceId: 'ws-b' };
      state.href = '/workspaces/ws-b';
    } else if (change === 'logout') {
      state.auth = { isLoaded: true, isSignedIn: false, userId: '' };
    } else {
      state.auth = {
        isLoaded: true,
        isSignedIn: true,
        userId: 'synthetic-account-b',
      };
    }
    await render();
    await act(async () => resolve(ready));
    await settle();
    expect(pane.selectedSessionId).toBe('a-latest');
  }
);

it('waits for authentication and local host discovery before resolving the link', async () => {
  state.auth.isSignedIn = false;
  await render();
  expect(state.status).not.toHaveBeenCalled();
  state.auth.isSignedIn = true;
  state.self.isPending = true;
  await render();
  expect(state.status).not.toHaveBeenCalled();
  state.self.isPending = false;
  await render();
  expect(pane.selectedSessionId).toBe('a-older');
});

it.each(['new', 'existing'])(
  'keeps a deliberate %s session choice made while the owner lookup is in flight',
  async (mode) => {
    let resolve!: (value: typeof ready) => void;
    state.status.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    await render();
    await act(async () =>
      mode === 'new' ? pane.startNewSession() : pane.selectSession('a-latest')
    );
    await act(async () => resolve(ready));
    await settle();
    expect(pane.isNewSessionMode).toBe(mode === 'new');
    expect(pane.selectedSessionId).toBe(
      mode === 'new' ? undefined : 'a-latest'
    );
  }
);
