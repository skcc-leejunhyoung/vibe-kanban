import { act, Children, isValidElement, useState, type ReactNode } from 'react';
import type { DropResult } from '@vibe/ui/components/KanbanBoard';
import { makeRequest } from '@/shared/lib/remoteApi';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import {
  ELECTRIC_READY_TIMEOUT_MS,
  FALLBACK_REFRESH_INTERVAL_MS,
} from '@/shared/lib/electric/collections';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureTestAuthRuntime,
  electricSessions,
  emitSnapshot,
  emitChange,
  emitError,
  emitSnapshotsByTable,
  installFakeDomReact,
  lastSessionFor,
  resetElectricSessions,
} from '@/shared/lib/electric/electricTestKit';
import { OrgContext, type OrgContextValue } from '@/shared/hooks/useOrgContext';
import { ProjectProvider } from '@/shared/providers/remote/ProjectProvider';
import {
  useProjectContext,
  type ProjectContextValue,
} from '@/shared/hooks/useProjectContext';
import { useIssueSelectionStore } from '@/shared/stores/useIssueSelectionStore';
import {
  DEFAULT_KANBAN_FILTER_STATE,
  useUiPreferencesStore,
  type KanbanFilterState,
} from '@/shared/stores/useUiPreferencesStore';
import { newGroup } from '@/shared/filters/filterTree';
import { makeRequest } from '@/shared/lib/remoteApi';
import { KanbanContainer } from './KanbanContainer';

/**
 * Renders the real KanbanContainer (ProjectProvider + real Electric-backed
 * collections, fake DOM) with every leaf UI component stubbed, and counts
 * KanbanCardContent renders per issue.
 */

// Shared by the hoisted vi.mock factories below, so hoisted with them.
const {
  contentRenders,
  refreshButtons,
  setDefaultCreateOptions,
  passthrough,
  nothing,
  noop,
  EMPTY,
  HOST_MAP,
  APP_NAVIGATION,
  route,
  pane,
  t,
} = vi.hoisted(() => ({
  contentRenders: vi.fn<(displayId: string) => void>(),
  refreshButtons: vi.fn<(onClick: () => void) => void>(),
  setDefaultCreateOptions: vi.fn(),
  passthrough: ({ children }: { children?: ReactNode }) => children ?? null,
  nothing: () => null,
  noop: () => {},
  EMPTY: [] as never[],
  HOST_MAP: new Map<string, string>(),
  // Real useAppNavigation returns a memoized object; mirror that so the
  // test measures the container, not a mock that changes every render.
  APP_NAVIGATION: {
    goToProjectIssue: () => {},
    goToProjectIssueWorkspace: () => {},
  },
  route: { projectId: '' },
  pane: { active: true },
  t: (key: string, fallback?: string) =>
    typeof fallback === 'string' ? fallback : key,
}));

vi.mock('@tanstack/electric-db-collection', async () => {
  const kit = await import('@/shared/lib/electric/electricTestKit');
  return { electricCollectionOptions: kit.fakeElectricCollectionOptions };
});
vi.mock('@/shared/hooks/useSelfCloudHostId', () => ({
  useSelfCloudHostId: () => ({ hostId: null, isPending: false }),
  getSelfCloudHostId: () => null,
}));
vi.mock('@/shared/lib/remoteApi', () => ({
  makeRequest: vi.fn(),
  getRemoteApiUrl: () => 'http://api.test',
  bulkUpdateIssues: vi.fn(async () => undefined),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
vi.mock('react-hotkeys-hook', () => ({ useHotkeys: noop }));
vi.mock('@phosphor-icons/react', () => ({
  PlusIcon: nothing,
  DotsThreeIcon: nothing,
  ArrowClockwiseIcon: nothing,
  SpinnerIcon: nothing,
}));
vi.mock('@vibe/ui/components/IconButton', () => ({
  IconButton: (props: { onClick: () => void }) => {
    refreshButtons(props.onClick);
    return null;
  },
}));
vi.mock('@vibe/ui/components/PrimaryButton', () => ({
  PrimaryButton: (props: { onClick: () => void }) => {
    refreshButtons(props.onClick);
    return null;
  },
}));
vi.mock('@/shared/actions', () => ({
  Actions: { ProjectsGuide: {}, ProjectSettings: {} },
}));
vi.mock('@/shared/keyboard', () => ({
  Scope: { KANBAN: 'kanban' },
  useKeyNavUp: noop,
  useKeyNavDown: noop,
  useKeyNavLeft: noop,
  useKeyNavRight: noop,
}));
vi.mock('@/shared/hooks/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    activeWorkspaces: EMPTY,
    archivedWorkspaces: EMPTY,
  }),
}));
vi.mock('@/shared/hooks/useActions', () => ({
  useActions: () => ({
    setDefaultCreateOptions,
    executeAction: noop,
    openPrioritySelection: noop,
    openAssigneeSelection: noop,
  }),
}));
vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({ userId: 'u1' }),
}));
vi.mock('@/shared/hooks/useAppNavigation', () => ({
  useAppNavigation: () => APP_NAVIGATION,
}));
vi.mock('@/shared/hooks/useWorkspaceHostMap', () => ({
  useWorkspaceHostMap: () => HOST_MAP,
}));
vi.mock('@/shared/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  useIsTouchDevice: () => false,
}));
vi.mock('@/shared/components/workspace-panes/PaneWidthContext', () => ({
  usePaneNarrowerThan: () => false,
}));
vi.mock('@/shared/components/workspace-panes/PaneActiveContext', () => ({
  useIsActivePane: () => pane.active,
}));
vi.mock('@/shared/hooks/useCurrentKanbanRouteState', () => ({
  useCurrentKanbanRouteState: () => ({
    projectId: route.projectId,
    issueId: undefined,
    hostId: null,
  }),
}));
vi.mock('@/shared/lib/openInSplitPane', () => ({
  useOpenInSplitPane: () => noop,
}));
const boardUi = vi.hoisted(() => ({
  onDragEnd: null as ((result: DropResult) => void) | null,
  columns: new Map<string, string[]>(),
}));
vi.mock('@vibe/ui/components/KanbanBoard', () => ({
  KanbanProvider: ({
    children,
    onDragEnd,
  }: {
    children?: ReactNode;
    onDragEnd: (result: DropResult) => void;
  }) => {
    boardUi.onDragEnd = onDragEnd;
    return children ?? null;
  },
  KanbanBoard: passthrough,
  KanbanCards: ({ id, children }: { id: string; children?: ReactNode }) => {
    boardUi.columns.set(
      id,
      Children.toArray(children)
        .filter(isValidElement<{ issue: { id: string } }>)
        .map((child) => child.props.issue.id)
    );
    return children ?? null;
  },
  KanbanHeader: passthrough,
  KanbanCard: passthrough,
}));
vi.mock('@vibe/ui/components/KanbanCardContent', () => ({
  KanbanCardContent: (props: { displayId: string }) => {
    contentRenders(props.displayId);
    return null;
  },
}));
vi.mock('@vibe/ui/components/IssueWorkspaceCard', () => ({
  IssueWorkspaceCard: nothing,
}));
vi.mock('@vibe/ui/components/ConfirmDialog', () => ({
  ConfirmDialog: { show: vi.fn() },
}));
vi.mock('@vibe/ui/components/KanbanFilterBar', () => ({
  KanbanFilterBar: nothing,
}));
vi.mock('@vibe/ui/components/ViewNavTabs', () => ({ ViewNavTabs: nothing }));
vi.mock('@vibe/ui/components/IssueListView', () => ({
  IssueListView: nothing,
}));
vi.mock('@vibe/ui/components/Dropdown', () => ({
  DropdownMenu: passthrough,
  DropdownMenuTrigger: passthrough,
  DropdownMenuContent: nothing,
  DropdownMenuItem: nothing,
}));
vi.mock('@/shared/dialogs/command-bar/CommandBarDialog', () => ({
  CommandBarDialog: { show: vi.fn() },
}));
vi.mock('@/shared/dialogs/kanban/KanbanFiltersDialog', () => ({
  KanbanFiltersDialog: nothing,
}));
vi.mock('@/shared/components/SearchableTagDropdownContainer', () => ({
  SearchableTagDropdownContainer: nothing,
}));
vi.mock('./BulkActionBarContainer', () => ({
  BulkActionBarContainer: nothing,
}));

let dom: ReturnType<typeof installFakeDomReact>;
let projectCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(makeRequest).mockReset();
  boardUi.columns.clear();
  vi.mocked(ConfirmDialog.show).mockClear();
  contentRenders.mockClear();
  refreshButtons.mockClear();
  vi.mocked(makeRequest).mockReset();
  setDefaultCreateOptions.mockClear();
  pane.active = true;
  useIssueSelectionStore.getState().clearSelection();
  useIssueSelectionStore.getState().setOrderedIssueIds([]);
  resetElectricSessions();
  configureTestAuthRuntime();
  dom = installFakeDomReact();
});

afterEach(async () => {
  await dom.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const member = {
  user_id: 'u1',
  first_name: 'Ada',
  last_name: 'L',
  email: 'ada@example.com',
  username: 'ada',
};

function seedRows(p: string): Record<string, Record<string, unknown>[]> {
  const issue = (id: string, sort: number) => ({
    id,
    project_id: p,
    issue_number: sort,
    simple_id: `VK-${sort}`,
    status_id: 's1',
    title: `Issue ${sort}`,
    description: null,
    priority: null,
    start_date: null,
    target_date: null,
    completed_at: null,
    sort_order: sort,
    parent_issue_id: null,
    parent_issue_sort_order: null,
    extension_metadata: {},
    creator_user_id: 'u1',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  });
  return {
    issues: [issue('i1', 1), issue('i2', 2)],
    project_statuses: [
      {
        id: 's2',
        project_id: p,
        name: 'Review',
        color: '0 0% 50%',
        sort_order: 2,
        hidden: false,
        created_at: '2026-09-01T00:00:00Z',
      },
      {
        id: 's1',
        project_id: p,
        name: 'Todo',
        color: '0 0% 50%',
        sort_order: 1,
        hidden: false,
        created_at: '2026-09-01T00:00:00Z',
      },
    ],
    tags: [{ id: 't1', project_id: p, name: 'bug', color: '#f00' }],
    issue_tags: [{ id: 'it1', project_id: p, issue_id: 'i1', tag_id: 't1' }],
    issue_assignees: [
      {
        id: 'ia1',
        project_id: p,
        issue_id: 'i1',
        user_id: 'u1',
        assigned_at: '2026-09-01T00:00:00Z',
      },
    ],
    issue_relationships: [
      {
        id: 'r1',
        project_id: p,
        issue_id: 'i1',
        related_issue_id: 'i2',
        relationship_type: 'blocking',
        created_at: '2026-09-01T00:00:00Z',
      },
    ],
    pull_requests: [
      {
        id: 'pr1',
        project_id: p,
        issue_id: 'i1',
        workspace_id: null,
        url: 'https://example.com/pr/1',
        number: 1,
        status: 'open',
      },
    ],
    pull_request_issues: [
      { id: 'pri1', project_id: p, pull_request_id: 'pr1', issue_id: 'i1' },
    ],
    github_issue_links: [
      {
        id: 'g1',
        project_id: p,
        issue_id: 'i1',
        repository: 'o/r',
        number: 7,
        url: 'https://example.com/issues/7',
        github_node_id: null,
        github_state: 'open',
      },
    ],
    workspaces: [
      {
        id: 'w1',
        project_id: p,
        issue_id: 'i1',
        owner_user_id: 'u1',
        host_id: null,
        local_workspace_id: null,
        name: 'ws',
        archived: false,
        files_changed: 1,
        lines_added: 2,
        lines_removed: 3,
        created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-09-01T00:00:00Z',
      },
    ],
  };
}

async function renderBoard(
  setup?: (projectId: string) => void,
  load = true,
  fallback = false
) {
  const projectId = `p${++projectCounter}`;
  route.projectId = projectId;
  setup?.(projectId);
  const orgValue = {
    organizationId: 'org',
    projects: [{ id: projectId, name: 'Project', organization_id: 'org' }],
    isLoading: false,
    error: null,
    retry: vi.fn(),
    membersWithProfilesById: new Map([['u1', member]]),
  } as unknown as OrgContextValue;

  let bump: () => void = () => {};
  let projectContext!: ProjectContextValue;
  function Probe() {
    projectContext = useProjectContext();
    return null;
  }
  function Host() {
    const [, setTick] = useState(0);
    bump = () => setTick((tick) => tick + 1);
    return (
      <OrgContext.Provider value={orgValue}>
        <ProjectProvider projectId={projectId}>
          <Probe />
          <KanbanContainer />
        </ProjectProvider>
      </OrgContext.Provider>
    );
  }
  await dom.render(<Host />);
  if (fallback) {
    const rows = seedRows(projectId);
    vi.mocked(makeRequest).mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: rows.issues }))
    );
    await act(() => {
      for (const session of electricSessions) {
        const table = session.id.slice(0, session.id.lastIndexOf('-'));
        if (table !== 'issues') emitSnapshot(session, rows[table] ?? []);
      }
    });
    await act(() =>
      vi.advanceTimersByTimeAsync(ELECTRIC_READY_TIMEOUT_MS + 10)
    );
  } else if (load) {
    await act(() => emitSnapshotsByTable(seedRows(projectId)));
  }
  await act(() => vi.advanceTimersByTimeAsync(0));

  return {
    projectId,
    retryOrg: orgValue.retry,
    context: () => projectContext,
    rerenderHost: () => act(() => bump()),
    change: (table: string, type: 'insert' | 'update', row: object) =>
      act(() =>
        emitChange(lastSessionFor(`${table}-${projectId}`), type, {
          project_id: projectId,
          ...row,
        })
      ),
    rendersOf: (displayId: string) =>
      contentRenders.mock.calls.filter(([id]) => id === displayId).length,
  };
}

describe('KanbanContainer project refresh', () => {
  it.each([true, false])(
    'refreshes only this project without remounting the board (loaded: %s)',
    async (load) => {
      const board = await renderBoard(undefined, load);
      const preferences = useUiPreferencesStore.getState().projectViewsById;
      vi.mocked(makeRequest).mockImplementation(async (path) => {
        const endpoint = /\/fallback\/(\w+)/.exec(path)?.[1] ?? '';
        const table =
          endpoint === 'project_workspaces' ? 'workspaces' : endpoint;
        return new Response(
          JSON.stringify({ [table]: seedRows(board.projectId)[table] ?? [] })
        );
      });
      expect(refreshButtons).toHaveBeenCalled();

      await act(async () => refreshButtons.mock.calls.at(-1)![0]());
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(board.retryOrg).toHaveBeenCalledOnce();
      expect(makeRequest).toHaveBeenCalledTimes(12);
      for (const [path] of vi.mocked(makeRequest).mock.calls) {
        expect(
          new URL(path, 'http://api.test').searchParams.get('project_id')
        ).toBe(board.projectId);
      }
      expect(board.rendersOf('VK-1')).toBeGreaterThan(0);
      expect(board.context().error).toBeNull();
      expect(useUiPreferencesStore.getState().projectViewsById).toBe(
        preferences
      );
    }
  );

  it('offers refresh after a failed initial load and recovers the cards', async () => {
    const board = await renderBoard(undefined, false);
    vi.mocked(makeRequest).mockRejectedValueOnce(new Error('Offline'));
    await act(async () =>
      emitError(lastSessionFor(`issues-${board.projectId}`), {
        message: 'Cancelled',
      })
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(contentRenders).not.toHaveBeenCalled();
    expect(refreshButtons).toHaveBeenCalled();

    vi.mocked(makeRequest).mockImplementation(async (path) => {
      const endpoint = /\/fallback\/(\w+)/.exec(path)?.[1] ?? '';
      const table = endpoint === 'project_workspaces' ? 'workspaces' : endpoint;
      return new Response(
        JSON.stringify({ [table]: seedRows(board.projectId)[table] ?? [] })
      );
    });
    await act(async () => refreshButtons.mock.calls.at(-1)![0]());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(board.rendersOf('VK-1')).toBeGreaterThan(0);
    expect(board.rendersOf('VK-2')).toBeGreaterThan(0);
    expect(board.context().error).toBeNull();
  });
});

describe('KanbanContainer card re-renders', () => {
  it('renders each card once on load', async () => {
    const board = await renderBoard();
    expect(board.rendersOf('VK-1')).toBe(1);
    expect(board.rendersOf('VK-2')).toBe(1);
  });

  it('does not re-render cards when an ancestor re-renders', async () => {
    const board = await renderBoard();
    contentRenders.mockClear();

    await board.rerenderHost();
    await board.rerenderHost();

    expect(contentRenders).not.toHaveBeenCalled();
  });

  it('does not re-render any card for shape messages no card shows', async () => {
    const board = await renderBoard();
    contentRenders.mockClear();

    await board.change('github_issue_links', 'insert', {
      id: 'g-none',
      issue_id: 'i-none',
      repository: 'o/r',
      number: 8,
      url: 'u',
      github_node_id: null,
      github_state: 'open',
    });
    await board.change('workspaces', 'insert', {
      id: 'w-none',
      issue_id: null,
      owner_user_id: 'u1',
      archived: false,
      updated_at: '2026-09-02T00:00:00Z',
    });
    await board.change('project_milestones', 'insert', {
      id: 'm-none',
      name: 'v9',
    });
    await board.change('pull_requests', 'insert', {
      id: 'pr-none',
      issue_id: 'i-none',
      workspace_id: null,
      url: 'u',
      number: 9,
      status: 'open',
    });

    expect(contentRenders).not.toHaveBeenCalled();
  });

  it('re-renders only the card whose data changed', async () => {
    const board = await renderBoard();
    contentRenders.mockClear();

    await board.change('issue_assignees', 'insert', {
      id: 'ia2',
      issue_id: 'i2',
      user_id: 'u1',
      assigned_at: '2026-09-02T00:00:00Z',
    });
    expect(board.rendersOf('VK-2')).toBe(1);
    expect(board.rendersOf('VK-1')).toBe(0);

    contentRenders.mockClear();
    await board.change('issues', 'update', {
      ...seedRows(board.projectId).issues[1],
      title: 'Issue 2 (edited)',
    });
    expect(board.rendersOf('VK-2')).toBe(1);
    expect(board.rendersOf('VK-1')).toBe(0);
  });
});

describe('KanbanContainer selection store', () => {
  it('publishes the issue order only while it is the active pane', async () => {
    // The selection store is shared by every split pane: an inactive board
    // must not overwrite the active one's order (Shift+Arrow ranges over it).
    pane.active = false;
    const board = await renderBoard();
    expect(useIssueSelectionStore.getState().orderedIssueIds).toEqual([]);

    pane.active = true;
    await board.rerenderHost();
    expect(useIssueSelectionStore.getState().orderedIssueIds).toEqual([
      'i1',
      'i2',
    ]);
  });
});

describe('KanbanContainer create defaults', () => {
  const withView =
    (
      filters: Partial<KanbanFilterState>,
      extra: { createTagIds?: string[] } = {}
    ) =>
    (p: string) =>
      useUiPreferencesStore.setState((state) => ({
        projectViewsById: {
          ...state.projectViewsById,
          [p]: [
            {
              id: 'v1',
              name: 'Bugs',
              layout: 'kanban',
              groupStatusIds: null,
              filters: { ...DEFAULT_KANBAN_FILTER_STATE, ...filters },
              showSubIssues: true,
              showWorkspaces: true,
              hideBlocked: false,
              ...extra,
            },
          ],
        },
      }));

  it('labels new issues with the view tag filter, minus deleted tags', async () => {
    await renderBoard(withView({ tagIds: ['t1', 't-deleted'] }));
    expect(setDefaultCreateOptions).toHaveBeenLastCalledWith({
      statusId: 's1',
      tagIds: ['t1'],
    });
  });

  it('ignores flat filter leftovers while an advanced tree is active', async () => {
    await renderBoard(
      withView({
        tagIds: ['t1'],
        assigneeIds: ['u1'],
        advancedFilter: newGroup('and'),
      })
    );
    expect(setDefaultCreateOptions).toHaveBeenLastCalledWith({
      statusId: 's1',
    });
  });

  it('attaches the view auto tags in any filter mode', async () => {
    await renderBoard(
      withView(
        { advancedFilter: newGroup('and') },
        { createTagIds: ['t1', 't-deleted'] }
      )
    );
    expect(setDefaultCreateOptions).toHaveBeenLastCalledWith({
      statusId: 's1',
      tagIds: ['t1'],
    });
  });
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function drop(source: string, destination: string, index = 0) {
  return act(() => {
    boardUi.onDragEnd!({
      draggableId: 'i1',
      type: 'DEFAULT',
      reason: 'DROP',
      mode: 'FLUID',
      combine: null,
      source: { droppableId: source, index: 0 },
      destination: { droppableId: destination, index },
    });
  });
}

async function setupFallbackBoard() {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  const board = await renderBoard(undefined, true, true);
  const gets: ReturnType<typeof deferredResponse>[] = [];
  const writes: ReturnType<typeof deferredResponse>[] = [];
  vi.mocked(makeRequest).mockImplementation((_path, init) => {
    const request = deferredResponse();
    (init?.method === 'GET' ? gets : writes).push(request);
    return request.promise;
  });
  const snapshot = (status = 's2') =>
    new Response(
      JSON.stringify({
        issues: seedRows(board.projectId).issues.map((row) =>
          row.id === 'i1'
            ? { ...row, status_id: status }
            : { ...row, title: 'Changed by a teammate' }
        ),
      })
    );
  return { ...board, gets, writes, snapshot };
}

const saved = () => new Response(JSON.stringify({ txid: 7 }));

describe('KanbanContainer fallback drag mutations', () => {
  it.each(['before', 'after'] as const)(
    'ignores a pre-save poll resolving %s the confirming GET',
    async (order) => {
      const { gets, writes, snapshot } = await setupFallbackBoard();
      await act(() =>
        vi.advanceTimersByTimeAsync(FALLBACK_REFRESH_INTERVAL_MS)
      );
      await drop('s1', 's2');
      expect(boardUi.columns.get('s2')).toContain('i1');
      expect(makeRequest).toHaveBeenLastCalledWith(
        '/v1/issues/bulk',
        expect.objectContaining({ method: 'POST' })
      );
      await act(async () => {
        writes[0].resolve(saved());
        await vi.advanceTimersByTimeAsync(501);
      });
      expect(gets).toHaveLength(2);
      if (order === 'before') {
        await act(async () => {
          gets[0].resolve(snapshot('s1'));
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(boardUi.columns.get('s2')).toContain('i1');
      }
      await act(async () => {
        gets[1].resolve(snapshot());
        await vi.advanceTimersByTimeAsync(0);
      });
      if (order === 'after') {
        await act(async () => {
          gets[0].resolve(snapshot('s1'));
          await vi.advanceTimersByTimeAsync(0);
        });
      }
      expect(boardUi.columns.get('s2')).toContain('i1');
    }
  );

  it('retains a saved move through GET failure until a poll succeeds', async () => {
    const { gets, writes, snapshot } = await setupFallbackBoard();
    await drop('s1', 's2');
    await act(async () => {
      writes[0].resolve(saved());
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      gets[0].resolve(new Response('offline', { status: 503 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(boardUi.columns.get('s2')).toContain('i1');
    await act(() => vi.advanceTimersByTimeAsync(FALLBACK_REFRESH_INTERVAL_MS));
    await act(async () => {
      gets[1].resolve(snapshot());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(boardUi.columns.get('s2')).toContain('i1');
    expect(writes).toHaveLength(1);
    expect(ConfirmDialog.show).not.toHaveBeenCalled();
  });

  it('rolls back a rejected save instead of leaving a moved card', async () => {
    const { gets, writes } = await setupFallbackBoard();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await drop('s1', 's2');
    await act(async () => {
      writes[0].resolve(new Response('denied', { status: 403 }));
      await vi.advanceTimersByTimeAsync(501);
    });
    expect(boardUi.columns.get('s1')).toContain('i1');
    expect(boardUi.columns.get('s2')).not.toContain('i1');
    expect(gets).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      'Failed to bulk update sort order:',
      expect.any(Error)
    );
    expect(ConfirmDialog.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'error', showCancelButton: false })
    );
    error.mockRestore();
  });

  it('keeps the latest of two drags when confirming GETs finish out of order', async () => {
    const { gets, writes, snapshot } = await setupFallbackBoard();
    await drop('s1', 's2');
    await act(async () => {
      writes[0].resolve(saved());
      await vi.advanceTimersByTimeAsync(0);
    });
    await drop('s2', 's1');
    await act(async () => {
      writes[1].resolve(saved());
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      gets[1].resolve(snapshot('s1'));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      gets[0].resolve(snapshot());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(boardUi.columns.get('s1')).toContain('i1');
    expect(boardUi.columns.get('s2')).not.toContain('i1');
  });

  it('optimistically reorders within a column and rolls back on save failure', async () => {
    const { writes } = await setupFallbackBoard();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await drop('s1', 's1', 1);
    expect(boardUi.columns.get('s1')).toEqual(['i2', 'i1']);
    await act(async () => {
      writes[0].resolve(new Response('denied', { status: 403 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(boardUi.columns.get('s1')).toEqual(['i1', 'i2']);
    error.mockRestore();
  });
});
