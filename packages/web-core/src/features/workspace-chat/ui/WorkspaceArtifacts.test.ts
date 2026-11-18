import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ArtifactSummary } from 'shared/types';
import { useWorkspaceArtifacts } from './WorkspaceArtifacts';

const state = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false, userId: null as string | null },
  list: vi.fn(),
}));
vi.mock('@/shared/hooks/auth/useAuth', () => ({ useAuth: () => state.auth }));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => 'synthetic-host',
}));
vi.mock('@/shared/lib/api', () => ({
  ownedArtifactsApi: { list: state.list },
}));
vi.mock('./DrawerArtifact', () => ({ DrawerArtifact: () => null }));

let root: Root;
let client: QueryClient;
let hook: ReturnType<typeof useWorkspaceArtifacts>;
function Probe() {
  hook = useWorkspaceArtifacts('synthetic-workspace', 'synthetic-session');
  return null;
}
async function render() {
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Probe))
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
  state.auth = { isLoaded: true, isSignedIn: false, userId: null };
  state.list
    .mockReset()
    .mockResolvedValue([{ id: 'synthetic-private-artifact' }]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(
    Object.assign(new EventTarget(), {
      nodeType: 1,
      tagName: 'DIV',
      ownerDocument: document,
    }) as unknown as HTMLElement
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  vi.unstubAllGlobals();
});

it('does not fetch while signed out and removes the previous account result on logout', async () => {
  await render();
  expect(state.list).not.toHaveBeenCalled();
  state.auth = {
    isLoaded: true,
    isSignedIn: true,
    userId: 'synthetic-account-a',
  };
  await render();
  expect(state.list).toHaveBeenCalledWith(
    'synthetic-workspace',
    'synthetic-session',
    'synthetic-host',
    expect.any(AbortSignal)
  );
  expect(hook.data).toEqual([{ id: 'synthetic-private-artifact' }]);
  state.auth = { isLoaded: true, isSignedIn: false, userId: null };
  await render();
  expect(hook.data).toBeUndefined();
});

it('does not expose a late account response after the account changes', async () => {
  let resolve!: (items: ArtifactSummary[]) => void;
  state.list.mockImplementationOnce(
    () =>
      new Promise<ArtifactSummary[]>((done) => {
        resolve = done;
      })
  );
  state.auth = {
    isLoaded: true,
    isSignedIn: true,
    userId: 'synthetic-account-a',
  };
  await render();
  state.auth = { isLoaded: true, isSignedIn: false, userId: null };
  await render();
  await act(async () =>
    resolve([{ id: 'synthetic-private-artifact' }] as ArtifactSummary[])
  );
  expect(hook.data).toBeUndefined();
});
