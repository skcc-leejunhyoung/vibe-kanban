import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import type { WorkspacePaneDestination } from '@/shared/stores/useWorkspacePanesStore';

// The panes store persists via localStorage, which the node test env lacks.
const memoryStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memoryStorage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memoryStorage.set(key, value);
  },
  removeItem: (key: string) => {
    memoryStorage.delete(key);
  },
});

// The cloud account signed in to the local app (`null` = signed out).
const account = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: account.userId !== null,
    userId: account.userId,
  }),
}));

const { useWorkspacePanesStore } = await import(
  '@/shared/stores/useWorkspacePanesStore'
);
const { ALL_WORKSPACE_HOSTS_ID, useWorkspaceHostSelectionStore } = await import(
  '@/shared/stores/useWorkspaceHostSelectionStore'
);
const { isAccountTakeover, useLocalAccountLayoutOwner } = await import(
  './useLocalAccountLayoutOwner'
);

const onHostB: WorkspacePaneDestination = {
  kind: 'workspace',
  workspaceId: 'workspace',
  hostId: 'host-b',
};
const paneCount = () => useWorkspacePanesStore.getState().panes.length;
const hostFilter = () =>
  useWorkspaceHostSelectionStore.getState().selectedHostId;

function Probe() {
  useLocalAccountLayoutOwner();
  return null;
}

let dom: ReturnType<typeof installDomlessReact>;
const signIn = (userId: string | null) => {
  account.userId = userId;
  return dom.render(<Probe />);
};

beforeEach(() => {
  dom = installDomlessReact();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStorage.delete(key);
    },
  });
  account.userId = null;
  useWorkspacePanesStore.setState({
    activeUserId: null,
    panes: [{ id: 'pane-1', destination: onHostB }],
    closedPanes: [],
    activePaneId: 'pane-1',
    layout: {},
    resizedPaneId: null,
  });
  useWorkspaceHostSelectionStore.setState({ selectedHostId: 'host-b' });
});
afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

describe('whose pane layout this is on the local app', () => {
  it('counts only a different account as a takeover', () => {
    expect(isAccountTakeover(null, 'account-one')).toBe(false);
    expect(isAccountTakeover('account-one', 'account-one')).toBe(false);
    expect(isAccountTakeover('account-one', 'account-two')).toBe(true);
  });

  it('keeps the layout through signing out and back in', async () => {
    await signIn('account-one');
    expect(paneCount()).toBe(1);
    expect(useWorkspacePanesStore.getState().activeUserId).toBe('account-one');

    // Signed out is a normal state here, and a sign-in can lapse on its own.
    await signIn(null);
    await signIn('account-one');
    expect(paneCount()).toBe(1);
    expect(hostFilter()).toBe('host-b');
  });

  it('clears the layout and the host filter when another account signs in', async () => {
    await signIn('account-one');
    await signIn(null);
    await signIn('account-two');
    // The panes pointed at account one's hosts: one empty pane remains, so
    // the grid that is already on screen has somewhere to open the next one.
    expect(paneCount()).toBe(1);
    expect(useWorkspacePanesStore.getState().panes[0].destination).toBeNull();
    expect(useWorkspacePanesStore.getState().activePaneId).toBe(
      useWorkspacePanesStore.getState().panes[0].id
    );
    expect(hostFilter()).toBe(ALL_WORKSPACE_HOSTS_ID);
    expect(useWorkspacePanesStore.getState().activeUserId).toBe('account-two');
  });
});
