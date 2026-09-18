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
  sessionsApi: { getByWorkspace: vi.fn() },
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
