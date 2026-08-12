import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store persists via localStorage, which the node test env lacks.
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

const { getAdjacentWorkspacePaneId, useWorkspacePanesStore } = await import(
  './useWorkspacePanesStore'
);

const store = useWorkspacePanesStore;

function reset() {
  store.setState({
    activeUserId: null,
    maxPanes: 4,
    nextPaneId: 1,
    panes: [],
    activePaneId: null,
    layout: {},
    focusSerial: 0,
  });
}

beforeEach(reset);

describe('setPaneCount', () => {
  it('adds empty secondary panes up to the requested total', () => {
    store.getState().setPaneCount(3);
    expect(store.getState().panes).toEqual([
      { id: 'pane-1', workspaceId: null, hostId: null },
      { id: 'pane-2', workspaceId: null, hostId: null },
    ]);
  });

  it('clamps to maxPanes and trims from the end', () => {
    store.getState().setPaneCount(9);
    expect(store.getState().panes).toHaveLength(3);

    store.getState().setActivePane('pane-3');
    store.getState().setPaneCount(2);
    expect(store.getState().panes).toHaveLength(1);
    // The active pane was trimmed → focus falls back to the primary pane.
    expect(store.getState().activePaneId).toBeNull();
  });
});

describe('openWorkspacePane', () => {
  it('appends a new pane and activates it', () => {
    store.getState().openWorkspacePane('ws-a', null);
    expect(store.getState().panes).toEqual([
      { id: 'pane-1', workspaceId: 'ws-a', hostId: null },
    ]);
    expect(store.getState().activePaneId).toBe('pane-1');
  });

  it('activates an existing pane showing the same workspace', () => {
    store.getState().openWorkspacePane('ws-a', null);
    store.getState().openWorkspacePane('ws-b', 'host-1');
    store.getState().setActivePane(null);

    store.getState().openWorkspacePane('ws-a', null);
    expect(store.getState().panes).toHaveLength(2);
    expect(store.getState().activePaneId).toBe('pane-1');
  });

  it('fills an empty pane before appending', () => {
    store.getState().setPaneCount(2);
    store.getState().openWorkspacePane('ws-a', null);
    expect(store.getState().panes).toEqual([
      { id: 'pane-1', workspaceId: 'ws-a', hostId: null },
    ]);
  });

  it('replaces the pane after the active one when the grid is full', () => {
    store.getState().openWorkspacePane('ws-a', null);
    store.getState().openWorkspacePane('ws-b', null);
    store.getState().openWorkspacePane('ws-c', null);
    expect(store.getState().panes).toHaveLength(3);

    store.getState().setActivePane('pane-1');
    store.getState().openWorkspacePane('ws-d', null);
    expect(store.getState().panes.map((pane) => pane.workspaceId)).toEqual([
      'ws-a',
      'ws-d',
      'ws-c',
    ]);
    expect(store.getState().activePaneId).toBe('pane-2');
  });

  it('treats the same workspace on different hosts as different panes', () => {
    store.getState().openWorkspacePane('ws-a', null);
    store.getState().openWorkspacePane('ws-a', 'host-1');
    expect(store.getState().panes).toHaveLength(2);
  });
});

describe('closePane / setMaxPanes / syncUser', () => {
  it('closing the active pane focuses the primary pane', () => {
    store.getState().openWorkspacePane('ws-a', null);
    store.getState().closePane('pane-1');
    expect(store.getState().panes).toEqual([]);
    expect(store.getState().activePaneId).toBeNull();
  });

  it('lowering maxPanes trims overflowing panes', () => {
    store.getState().openWorkspacePane('ws-a', null);
    store.getState().openWorkspacePane('ws-b', null);
    store.getState().setMaxPanes(2);
    expect(store.getState().panes.map((pane) => pane.workspaceId)).toEqual([
      'ws-a',
    ]);
  });

  it('switching users resets panes but keeps maxPanes', () => {
    store.getState().setMaxPanes(6);
    store.getState().openWorkspacePane('ws-a', null);
    store.getState().syncUser('user-1');
    expect(store.getState().panes).toEqual([]);
    expect(store.getState().maxPanes).toBe(6);

    // Same user again is a no-op.
    store.getState().openWorkspacePane('ws-b', null);
    store.getState().syncUser('user-1');
    expect(store.getState().panes).toHaveLength(1);
  });
});

describe('pane focus cycling', () => {
  it('cycles through primary and secondary panes in order', () => {
    store.getState().openWorkspacePane('ws-a', null);
    store.getState().openWorkspacePane('ws-b', null);
    const panes = store.getState().panes;

    expect(getAdjacentWorkspacePaneId(panes, null, 'next')).toBe('pane-1');
    expect(getAdjacentWorkspacePaneId(panes, 'pane-2', 'next')).toBeNull();
    expect(getAdjacentWorkspacePaneId(panes, null, 'previous')).toBe('pane-2');
  });

  it('cycleActivePane bumps focusSerial for keyboard focus handoff', () => {
    store.getState().cycleActivePane('next');
    expect(store.getState().focusSerial).toBe(0); // no panes → no-op

    store.getState().openWorkspacePane('ws-a', null);
    store.getState().setActivePane(null);
    store.getState().cycleActivePane('next');
    expect(store.getState().activePaneId).toBe('pane-1');
    expect(store.getState().focusSerial).toBe(1);
  });
});
