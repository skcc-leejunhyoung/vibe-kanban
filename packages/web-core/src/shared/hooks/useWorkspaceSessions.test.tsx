import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from 'shared/types';
import { workspaceSessionKeys } from './workspaceSessionKeys';
import {
  useWorkspaceSessionSelectionStore,
  useWorkspaceSessions,
} from './useWorkspaceSessions';

vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => null,
}));
vi.mock('@/shared/lib/api', () => ({
  // Never resolves: the tests drive the cache directly and keep queries pending.
  sessionsApi: { getByWorkspace: vi.fn(() => new Promise(() => {})) },
}));

function sessionList(ids: string[]): Session[] {
  return ids.map((id) => ({ id })) as Session[];
}

let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // The probe renders no DOM nodes; only a root surface is needed for React's
  // effects, context and store subscriptions to run.
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
  const container = Object.assign(new EventTarget(), {
    nodeType: 1,
    tagName: 'DIV',
    ownerDocument: document,
  });
  root = createRoot(container as unknown as HTMLElement);
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(
    workspaceSessionKeys.byWorkspace('ws-a', null),
    sessionList(['a-latest', 'a-older'])
  );
  queryClient.setQueryData(
    workspaceSessionKeys.byWorkspace('ws-b', null),
    sessionList(['b-latest'])
  );
  useWorkspaceSessionSelectionStore.setState({ selections: {} });
});

afterEach(async () => {
  await act(() => root.unmount());
  queryClient.clear();
  vi.unstubAllGlobals();
});

/**
 * Two instances of the hook for the same workspace, as the app runs them: the
 * pane's own WorkspaceProvider (fixed destination) and the document-level one
 * in the app shell, whose workspaceId follows the URL — i.e. the active pane.
 */
function renderPaneAndDocument() {
  let pane!: ReturnType<typeof useWorkspaceSessions>;

  function Probe({ documentWorkspaceId }: { documentWorkspaceId?: string }) {
    pane = useWorkspaceSessions('ws-a');
    useWorkspaceSessions(documentWorkspaceId);
    return null;
  }

  const render = (node: ReactNode) =>
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
      )
    );

  return {
    get pane() {
      return pane;
    },
    /** Move the document URL (active pane) to another destination and back. */
    focusDocumentOn: (documentWorkspaceId?: string) =>
      render(<Probe documentWorkspaceId={documentWorkspaceId} />),
  };
}

describe('useWorkspaceSessions', () => {
  it('auto-selects the most recently used session', async () => {
    const probe = renderPaneAndDocument();
    await probe.focusDocumentOn('ws-a');

    expect(probe.pane.selectedSessionId).toBe('a-latest');
    expect(probe.pane.isNewSessionMode).toBe(false);
  });

  it('keeps a pane in new-session mode when focus leaves and comes back', async () => {
    const probe = renderPaneAndDocument();
    await probe.focusDocumentOn('ws-a');

    await act(async () => probe.pane.startNewSession());
    expect(probe.pane.isNewSessionMode).toBe(true);

    // Another pane gets focus (URL mirrors it), then the new-session pane again.
    await probe.focusDocumentOn('ws-b');
    await probe.focusDocumentOn('ws-a');

    expect(probe.pane.isNewSessionMode).toBe(true);
    expect(probe.pane.selectedSessionId).toBeUndefined();
  });

  it('keeps a user-picked session when focus leaves and comes back', async () => {
    const probe = renderPaneAndDocument();
    await probe.focusDocumentOn('ws-a');

    await act(async () => probe.pane.selectSession('a-older'));
    await probe.focusDocumentOn('ws-b');
    await probe.focusDocumentOn('ws-a');

    expect(probe.pane.selectedSessionId).toBe('a-older');
  });

  it('falls back to the latest session when the selected one is gone', async () => {
    const probe = renderPaneAndDocument();
    await probe.focusDocumentOn('ws-a');
    await act(async () => probe.pane.selectSession('a-older'));

    queryClient.setQueryData(
      workspaceSessionKeys.byWorkspace('ws-a', null),
      sessionList(['a-latest'])
    );
    // react-query notifies observers through its scheduler, not synchronously.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(probe.pane.selectedSessionId).toBe('a-latest');
  });

  it('keeps new-session mode picked before the session list loaded', async () => {
    // A pane opened on a workspace whose sessions are not cached yet shows the
    // composer right away, so the user can pick "new session" before the list
    // lands. That choice must survive the list arriving.
    queryClient.removeQueries({
      queryKey: workspaceSessionKeys.byWorkspace('ws-a', null),
    });
    const probe = renderPaneAndDocument();
    await probe.focusDocumentOn('ws-a');

    await act(async () => probe.pane.startNewSession());
    expect(probe.pane.isNewSessionMode).toBe(true);

    queryClient.setQueryData(
      workspaceSessionKeys.byWorkspace('ws-a', null),
      sessionList(['a-latest', 'a-older'])
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(probe.pane.isNewSessionMode).toBe(true);
    expect(probe.pane.selectedSessionId).toBeUndefined();
  });

  it('keeps the selection when the cached list is evicted', async () => {
    const probe = renderPaneAndDocument();
    await probe.focusDocumentOn('ws-a');
    await act(async () => probe.pane.selectSession('a-older'));

    // The pane stays mounted while the list goes back to "unknown" (eviction,
    // a reset landing): that must not be read as "this workspace has no
    // sessions" and drop what the user is looking at.
    await act(async () => {
      queryClient
        .getQueryCache()
        .find({ queryKey: workspaceSessionKeys.byWorkspace('ws-a', null) })!
        .setData(undefined as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      useWorkspaceSessionSelectionStore.getState().selections[':ws-a']
    ).toEqual({ mode: 'existing', sessionId: 'a-older' });
  });

  it('does not leak new-session mode into another workspace', async () => {
    const probe = renderPaneAndDocument();
    await probe.focusDocumentOn('ws-a');

    await act(async () => probe.pane.startNewSession());
    await probe.focusDocumentOn('ws-b');

    expect(
      useWorkspaceSessionSelectionStore.getState().selections[':ws-b']
    ).toEqual({ mode: 'existing', sessionId: 'b-latest' });
  });
});
