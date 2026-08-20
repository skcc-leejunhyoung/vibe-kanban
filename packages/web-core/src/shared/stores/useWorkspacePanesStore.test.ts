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
  isPaneSeparatorActive,
  layoutForPanes,
  paneDestinationKey,
  resizePaneWithEqualSiblings,
  sameDestination,
  useWorkspacePanesStore,
} = await import('./useWorkspacePanesStore');

const store = useWorkspacePanesStore;

const ws = (
  workspaceId: string,
  hostId: string | null = null
): WorkspacePaneDestination => ({ kind: 'workspace', workspaceId, hostId });

const panes = (...ids: string[]) =>
  ids.map((id) => ({ id, destination: null }));

function reset() {
  store.setState({
    activeUserId: null,
    maxPanes: 4,
    nextPaneId: 1,
    panes: [],
    activePaneId: null,
    layout: {},
    resizedPaneId: null,
    focusSerial: 0,
    paneOrderVersions: {},
  });
}

beforeEach(reset);

describe('ensurePane / appendPane / focusPaneAt', () => {
  it('creates a single empty pane on boot', () => {
    store.getState().ensurePane();
    expect(store.getState().panes).toEqual([
      { id: 'pane-1', destination: null },
    ]);
    expect(store.getState().activePaneId).toBe('pane-1');
    expect(store.getState().layout['pane-1']).toBe(100);
  });

  it('appends an empty pane at the right edge and focuses it', () => {
    store.getState().ensurePane();
    store.getState().openPaneForDestination(ws('ws-a'));
    store.getState().openPaneForDestination(ws('ws-b'));
    store.getState().setActivePane('pane-1');

    store.getState().appendPane();
    expect(store.getState().panes.map((pane) => pane.id)).toEqual([
      'pane-1',
      'pane-2',
      'pane-3',
    ]);
    expect(store.getState().activePaneId).toBe('pane-3');
    // Every pane has the same width after a structural change.
    expect(store.getState().layout['pane-1']).toBeCloseTo(100 / 3);
    expect(store.getState().layout['pane-3']).toBeCloseTo(100 / 3);
    expect(store.getState().layout['pane-2']).toBeCloseTo(100 / 3);
    expect(store.getState().focusSerial).toBe(1);
  });

  it('caps inserts at maxPanes', () => {
    store.getState().ensurePane();
    for (let i = 0; i < 5; i += 1) store.getState().appendPane();
    expect(store.getState().panes).toHaveLength(4); // maxPanes
  });

  it('keeps the explicitly resized pane and equalizes new siblings', () => {
    store.getState().ensurePane();
    store.getState().appendPane();
    store.getState().appendPane();
    store
      .getState()
      .setLayout({ 'pane-1': 50, 'pane-2': 25, 'pane-3': 25 }, 'pane-1');

    store.getState().appendPane();

    expect(store.getState().layout['pane-1']).toBeCloseTo(50);
    expect(store.getState().layout['pane-2']).toBeCloseTo(50 / 3);
    expect(store.getState().layout['pane-3']).toBeCloseTo(50 / 3);
    expect(store.getState().layout['pane-4']).toBeCloseTo(50 / 3);
  });

  it('focusPaneAt focuses existing panes only and requests DOM focus', () => {
    store.getState().ensurePane();
    store.getState().appendPane();
    const serial = store.getState().focusSerial;

    store.getState().focusPaneAt(0);
    expect(store.getState().activePaneId).toBe('pane-1');
    expect(store.getState().focusSerial).toBe(serial + 1);

    store.getState().focusPaneAt(5);
    expect(store.getState().activePaneId).toBe('pane-1');
    expect(store.getState().focusSerial).toBe(serial + 1);
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

  it('folds workspace-create into the existing project pane', () => {
    store
      .getState()
      .openPaneForDestination({ kind: 'project', projectId: 'p1' });
    store.getState().adoptRouteDestination({
      kind: 'project-workspace-create',
      projectId: 'p1',
      draftId: 'd1',
    });
    // Same project pane, content swapped to create mode — no new pane spawned.
    expect(store.getState().panes).toHaveLength(1);
    expect(store.getState().panes[0].destination).toEqual({
      kind: 'project-workspace-create',
      projectId: 'p1',
      draftId: 'd1',
    });
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

  it('equalizes remaining panes and refocuses the left neighbour', () => {
    store.getState().openPaneForDestination(ws('ws-a'));
    store.getState().openPaneForDestination(ws('ws-b'));
    store.getState().openPaneForDestination(ws('ws-c'));
    // Equal remaining panes expand equally.
    store.getState().closePane('pane-3');
    expect(store.getState().panes.map((pane) => pane.id)).toEqual([
      'pane-1',
      'pane-2',
    ]);
    expect(store.getState().layout['pane-1']).toBeCloseTo(50);
    expect(store.getState().layout['pane-2']).toBeCloseTo(50);
    expect(store.getState().activePaneId).toBe('pane-2');
  });

  it('equalizes every pane after the explicitly resized pane closes', () => {
    store.getState().appendPane();
    store.getState().appendPane();
    store
      .getState()
      .setLayout({ 'pane-1': 50, 'pane-2': 25, 'pane-3': 25 }, 'pane-1');

    store.getState().closePane('pane-1');

    expect(store.getState().layout['pane-2']).toBeCloseTo(50);
    expect(store.getState().layout['pane-3']).toBeCloseTo(50);
    expect(store.getState().resizedPaneId).toBeNull();
  });
});

describe('movePane', () => {
  it('moves a pane before the drop target without changing its identity', () => {
    store.getState().ensurePane();
    store.getState().appendPane();
    store.getState().appendPane();

    store.getState().movePane('pane-3', 'pane-1', false);

    expect(store.getState().panes.map((pane) => pane.id)).toEqual([
      'pane-3',
      'pane-1',
      'pane-2',
    ]);
    expect(store.getState().activePaneId).toBe('pane-3');
    expect(store.getState().paneOrderVersions).toEqual({ 'pane-3': 1 });

    store.getState().movePane('pane-3', 'pane-2', true);
    expect(store.getState().panes.map((pane) => pane.id)).toEqual([
      'pane-1',
      'pane-2',
      'pane-3',
    ]);
    expect(store.getState().paneOrderVersions).toEqual({ 'pane-3': 2 });

    store.getState().movePane('pane-1', 'pane-3', true);
    expect(store.getState().paneOrderVersions).toEqual({
      'pane-1': 1,
      'pane-3': 2,
    });
  });
});

describe('clearPaneDestination', () => {
  it('shows the picker without changing the pane structure', () => {
    store.getState().ensurePane();
    store.getState().openPaneForDestination(ws('ws-a'));
    store.getState().openPaneForDestination({ kind: 'pull-requests' });

    store.getState().clearPaneDestination('pane-2');

    expect(store.getState().panes).toEqual([
      { id: 'pane-1', destination: ws('ws-a') },
      { id: 'pane-2', destination: null },
    ]);
  });
});

describe('layout math', () => {
  it('makes panes equal when none was explicitly resized', () => {
    const layout = layoutForPanes(panes('a', 'b', 'new'), {}, null);
    expect(layout.a).toBeCloseTo(100 / 3);
    expect(layout.new).toBeCloseTo(100 / 3);
    expect(layout.b).toBeCloseTo(100 / 3);
  });

  it('preserves the explicitly resized pane across structural changes', () => {
    const layout = layoutForPanes(
      panes('a', 'b', 'new'),
      { a: 50, b: 25 },
      'a'
    );
    expect(layout.a).toBeCloseTo(50);
    expect(layout.b).toBeCloseTo(25);
    expect(layout.new).toBeCloseTo(25);
  });

  it('resizes all other panes equally within their minimum size', () => {
    expect(
      resizePaneWithEqualSiblings({ a: 20, b: 30, c: 50 }, 'b', 50, 10)
    ).toEqual({ a: 25, b: 50, c: 25 });
    expect(
      resizePaneWithEqualSiblings({ a: 20, b: 30, c: 50 }, 'b', 80, 10)
    ).toEqual({ a: 10, b: 80, c: 10 });
  });
});

describe('helpers', () => {
  it('enables only separators next to the active pane', () => {
    const allPanes = panes('a', 'b', 'c', 'd');
    expect(isPaneSeparatorActive(allPanes, 0, 'a')).toBe(false);
    expect(isPaneSeparatorActive(allPanes, 1, 'c')).toBe(false);
    expect(isPaneSeparatorActive(allPanes, 2, 'c')).toBe(true);
    expect(isPaneSeparatorActive(allPanes, 3, 'c')).toBe(true);
  });

  it('gives workspace and pull requests distinct render identities', () => {
    expect(paneDestinationKey(ws('ws-a'))).not.toBe(
      paneDestinationKey({ kind: 'pull-requests' })
    );
  });

  it('cycles across panes and reports focus serial', () => {
    store.getState().ensurePane();
    store.getState().openPaneForDestination(ws('ws-a'));
    store.getState().openPaneForDestination(ws('ws-b'));
    store.getState().appendPane();
    const allPanes = store.getState().panes;
    expect(getAdjacentWorkspacePaneId(allPanes, 'pane-2', 'next')).toBe(
      'pane-3'
    );
    expect(getAdjacentWorkspacePaneId(allPanes, 'pane-2', 'previous')).toBe(
      'pane-1'
    );

    store.getState().cycleActivePane('next');
    expect(store.getState().activePaneId).toBe('pane-1');
    expect(store.getState().focusSerial).toBe(2);
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
    expect(
      sameDestination(
        { kind: 'pull-requests', prUrl: 'https://example.com/pull/1' },
        { kind: 'pull-requests', prUrl: 'https://example.com/pull/2' }
      )
    ).toBe(false);
  });
});
