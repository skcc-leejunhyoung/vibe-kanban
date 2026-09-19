import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNavigation } from '@/shared/lib/routes/appNavigation';
import type { WorkspacePaneDestination } from '@/shared/stores/useWorkspacePanesStore';

// The pane store persists via localStorage, which the node test env lacks.
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
// `paneGridAvailable` asks the viewport; `ensurePaneGridVisible` the path.
let isMobile = false;
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: isMobile }),
  location: { pathname: '/workspaces' },
});

const { openDestinationInOwnPane, paneGridAvailable, revealDestinationInPane } =
  await import('./openInSplitPane');
const { useWorkspacePanesStore } = await import(
  '@/shared/stores/useWorkspacePanesStore'
);

describe('paneGridAvailable', () => {
  it('supports both desktop apps but not mobile', () => {
    expect(paneGridAvailable('local', false)).toBe(true);
    expect(paneGridAvailable('remote', false)).toBe(true);
    expect(paneGridAvailable('remote', true)).toBe(false);
  });
});

describe('openDestinationInOwnPane', () => {
  // Already on the grid, so `ensurePaneGridVisible` is a no-op here.
  const navigation = {
    resolveFromPath: () => ({ kind: 'workspaces' }),
    goToWorkspaces: vi.fn(),
  } as unknown as AppNavigation;
  const terminal: WorkspacePaneDestination = { kind: 'terminal' };
  const ws = (workspaceId: string): WorkspacePaneDestination => ({
    kind: 'workspace',
    workspaceId,
    hostId: null,
  });

  function seed(
    destinations: (WorkspacePaneDestination | null)[],
    maxPanes: number
  ) {
    useWorkspacePanesStore.setState({
      panes: destinations.map((destination, index) => ({
        id: `pane-${index}`,
        destination,
      })),
      activePaneId: 'pane-0',
      maxPanes,
      nextPaneId: destinations.length,
      layout: {},
      resizedPaneId: null,
      focusSerial: 0,
    });
  }

  const state = () => useWorkspacePanesStore.getState();
  const paneKinds = () => state().panes.map((p) => p.destination?.kind);

  beforeEach(() => {
    isMobile = false;
  });

  it('appends a pane while the grid has room, and moves focus there', () => {
    seed([ws('ws1')], 4);
    const serialBefore = state().focusSerial;

    expect(
      openDestinationInOwnPane(terminal, navigation, 'local', vi.fn())
    ).toBe(true);

    expect(paneKinds()).toEqual(['workspace', 'terminal']);
    expect(state().activePaneId).toBe('pane-1');
    // Without this the pane opens but the caret stays where it was.
    expect(state().focusSerial).toBe(serialBefore + 1);
  });

  it('takes over a pane once the grid is full, instead of navigating away', () => {
    seed([ws('ws1'), ws('ws2')], 2);
    const navigateDocument = vi.fn();

    openDestinationInOwnPane(terminal, navigation, 'local', navigateDocument);

    expect(paneKinds()).toEqual(['workspace', 'terminal']);
    expect(state().activePaneId).toBe('pane-1');
    expect(navigateDocument).not.toHaveBeenCalled();
  });

  it('focuses the pane already showing it rather than opening a second one', () => {
    // One PTY and one xterm element: a second pane adopts it away and leaves
    // the first blank, so this must never duplicate.
    seed([ws('ws1'), terminal], 4);

    openDestinationInOwnPane(terminal, navigation, 'local', vi.fn());

    expect(paneKinds()).toEqual(['workspace', 'terminal']);
    expect(state().activePaneId).toBe('pane-1');
  });

  it('navigates the document where there is no pane grid', () => {
    seed([ws('ws1')], 4);
    isMobile = true;
    const navigateDocument = vi.fn();

    // False tells the caller it kept no pane, so its own focus restore stands.
    expect(
      openDestinationInOwnPane(terminal, navigation, 'local', navigateDocument)
    ).toBe(false);

    expect(navigateDocument).toHaveBeenCalled();
    expect(paneKinds()).toEqual(['workspace']);
  });

  describe('revealDestinationInPane', () => {
    // The command bar declines its own focus restore for these actions, so if
    // this path skipped the focus request the caret would land on <body> and
    // keystrokes would go nowhere.
    it('requests DOM focus even when the pane already shows it', () => {
      seed([ws('ws1'), terminal], 4);
      const serialBefore = state().focusSerial;

      revealDestinationInPane(terminal, navigation, 'local', vi.fn());

      expect(state().activePaneId).toBe('pane-1');
      expect(state().focusSerial).toBe(serialBefore + 1);
    });

    it('leaves focus alone when it navigated the document instead', () => {
      seed([ws('ws1')], 4);
      isMobile = true;
      const serialBefore = state().focusSerial;
      const navigateDocument = vi.fn();

      revealDestinationInPane(terminal, navigation, 'local', navigateDocument);

      expect(navigateDocument).toHaveBeenCalled();
      expect(state().focusSerial).toBe(serialBefore);
    });
  });
});
