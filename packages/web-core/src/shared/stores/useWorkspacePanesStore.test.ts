import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspacePaneDestination } from './useWorkspacePanesStore';

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

const {
  getAdjacentWorkspacePaneId,
  getActivePaneWorkspace,
  layoutAfterClose,
  layoutAfterSplit,
  sameDestination,
  useWorkspacePanesStore,
} = await import('./useWorkspacePanesStore');

const store = useWorkspacePanesStore;

const ws = (
  workspaceId: string,
  hostId: string | null = null
): WorkspacePaneDestination => ({ kind: 'workspace', workspaceId, hostId });

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

describe('ensurePane / setPaneCount', () => {
  it('creates a single empty pane on boot', () => {
    store.getState().ensurePane();
    expect(store.getState().panes).toEqual([
      { id: 'pane-1', destination: null },
    ]);
    expect(store.getState().activePaneId).toBe('pane-1');
    expect(store.getState().layout['pane-1']).toBe(100);
  });

  it('sets the total pane count, clamped to maxPanes and at least one', () => {
    store.getState().ensurePane();
    store.getState().setPaneCount(3);
    expect(store.getState().panes).toHaveLength(3);

    store.getState().setPaneCount(9);
    expect(store.getState().panes).toHaveLength(4); // maxPanes

    store.getState().setPaneCount(0);
    expect(store.getState().panes).toHaveLength(1);
  });

  it('keeps the active pane when still present after trimming', () => {
    store.getState().ensurePane();
    store.getState().setPaneCount(3);
    store.getState().setActivePane('pane-3');
    store.getState().setPaneCount(2);
    expect(store.getState().activePaneId).toBe('pane-2');
  });
});

describe('openPaneForDestination', () => {
  beforeEach(() => {
    store.getState().ensurePane();
  });

  it('fills the empty boot pane first', () => {
    store.getState().openPaneForDestination(ws('ws-a'));
    expect(store.getState().panes).toEqual([
      { id: 'pane-1', destination: ws('ws-a') },
    ]);
    expect(store.getState().activePaneId).toBe('pane-1');
  });

  it('splits the active pane for a new destination', () => {
    store.getState().openPaneForDestination(ws('ws-a'));
    store.getState().openPaneForDestination(ws('ws-b'));
    expect(store.getState().panes).toHaveLength(2);
    expect(store.getState().activePaneId).toBe('pane-2');
    // New pane takes half of the reference pane's width.
    expect(store.getState().layout['pane-1']).toBeCloseTo(50);
    expect(store.getState().layout['pane-2']).toBeCloseTo(50);
  });

  it('activates an existing pane showing the same workspace', () => {
    store.getState().openPaneForDestination(ws('ws-a'));
    store.getState().openPaneForDestination(ws('ws-b', 'host-1'));
    store.getState().setActivePane('pane-1');

    store.getState().openPaneForDestination(ws('ws-b', 'host-1'));
    expect(store.getState().panes).toHaveLength(2);
    expect(store.getState().activePaneId).toBe('pane-2');
  });

  it('dedupes project destinations per project and adopts sub-navigation', () => {
    store
      .getState()
      .openPaneForDestination({ kind: 'project', projectId: 'p1' });
    store.getState().openPaneForDestination({
      kind: 'project-issue',
      projectId: 'p1',
      issueId: 'i1',
    });
    expect(store.getState().panes).toHaveLength(1);
    expect(store.getState().panes[0].destination).toEqual({
      kind: 'project-issue',
      projectId: 'p1',
      issueId: 'i1',
    });
  });

  it('replaces the pane after the active one when the grid is full', () => {
    for (const id of ['ws-a', 'ws-b', 'ws-c', 'ws-d']) {
      store.getState().openPaneForDestination(ws(id));
    }
    expect(store.getState().panes).toHaveLength(4);

    store.getState().setActivePane('pane-1');
    store.getState().openPaneForDestination(ws('ws-e'));
    expect(store.getState().panes).toHaveLength(4);
    expect(
      store.getState().panes.map((pane) => pane.destination?.workspaceId)
    ).toEqual(['ws-a', 'ws-e', 'ws-c', 'ws-d']);
    expect(store.getState().activePaneId).toBe('pane-2');
  });
});

describe('adoptRouteDestination', () => {
  beforeEach(() => {
    store.getState().ensurePane();
  });

  it('replaces the active pane content without changing the structure', () => {
    store.getState().openPaneForDestination(ws('ws-a'));
    store.getState().openPaneForDestination(ws('ws-b'));
    store.getState().adoptRouteDestination(ws('ws-c'));
    expect(store.getState().panes).toHaveLength(2);
    expect(store.getState().panes[1].destination).toEqual(ws('ws-c'));
  });

  it('activates the pane already showing the destination', () => {
    store.getState().openPaneForDestination(ws('ws-a'));
    store.getState().openPaneForDestination(ws('ws-b'));
    store.getState().adoptRouteDestination(ws('ws-a'));
    expect(store.getState().activePaneId).toBe('pane-1');
    expect(store.getState().panes).toHaveLength(2);
  });
});

describe('closePane', () => {
  beforeEach(() => {
    store.getState().ensurePane();
  });

  it('clears the last pane instead of removing it', () => {
    store.getState().openPaneForDestination(ws('ws-a'));
    store.getState().closePane('pane-1');
    expect(store.getState().panes).toEqual([
      { id: 'pane-1', destination: null },
    ]);
  });

  it('gives the closed width to the left neighbour and refocuses it', () => {
    store.getState().openPaneForDestination(ws('ws-a'));
    store.getState().openPaneForDestination(ws('ws-b'));
    store.getState().openPaneForDestination(ws('ws-c'));
    // pane-1: 50, pane-2: 25, pane-3: 25
    store.getState().closePane('pane-3');
    expect(store.getState().panes.map((pane) => pane.id)).toEqual([
      'pane-1',
      'pane-2',
    ]);
    expect(store.getState().layout['pane-2']).toBeCloseTo(50);
    expect(store.getState().activePaneId).toBe('pane-2');
  });
});

describe('layout math', () => {
  const panes = (...ids: string[]) =>
    ids.map((id) => ({ id, destination: null }));

  it('layoutAfterSplit halves the reference pane only', () => {
    const layout = layoutAfterSplit(
      panes('a', 'b', 'new'),
      { a: 60, b: 40 },
      'a',
      'new'
    );
    expect(layout.a).toBeCloseTo(30);
    expect(layout.new).toBeCloseTo(30);
    expect(layout.b).toBeCloseTo(40);
  });

  it('layoutAfterClose returns the width to the left neighbour', () => {
    const layout = layoutAfterClose(
      panes('a', 'b', 'c'),
      {
        a: 20,
        b: 30,
        c: 50,
      },
      'c'
    );
    expect(layout.a).toBeCloseTo(20);
    expect(layout.b).toBeCloseTo(80);
  });
});

describe('helpers', () => {
  it('cycles across panes and reports focus serial', () => {
    store.getState().ensurePane();
    store.getState().openPaneForDestination(ws('ws-a'));
    store.getState().openPaneForDestination(ws('ws-b'));
    const allPanes = store.getState().panes;
    expect(getAdjacentWorkspacePaneId(allPanes, 'pane-2', 'next')).toBe(
      'pane-1'
    );
    expect(getAdjacentWorkspacePaneId(allPanes, 'pane-1', 'previous')).toBe(
      'pane-2'
    );

    store.getState().cycleActivePane('next');
    expect(store.getState().focusSerial).toBe(1);
  });

  it('getActivePaneWorkspace only reports workspace destinations', () => {
    store.getState().ensurePane();
    store.getState().openPaneForDestination(ws('ws-a', 'host-1'));
    expect(getActivePaneWorkspace(store.getState())).toEqual({
      workspaceId: 'ws-a',
      hostId: 'host-1',
    });

    store.getState().openPaneForDestination({ kind: 'notifications' });
    expect(getActivePaneWorkspace(store.getState())).toBeNull();
  });

  it('sameDestination folds hostId null/undefined', () => {
    expect(
      sameDestination(
        { kind: 'workspace', workspaceId: 'w' },
        { kind: 'workspace', workspaceId: 'w', hostId: null }
      )
    ).toBe(true);
    expect(
      sameDestination(
        { kind: 'workspace', workspaceId: 'w', hostId: 'h' },
        { kind: 'workspace', workspaceId: 'w' }
      )
    ).toBe(false);
    expect(sameDestination({ kind: 'pull-requests' }, null)).toBe(false);
  });
});
