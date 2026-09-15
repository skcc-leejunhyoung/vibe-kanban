import { act, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureTestAuthRuntime,
  emitChange,
  emitSnapshotsByTable,
  installFakeDomReact,
  lastSessionFor,
  resetElectricSessions,
} from '@/shared/lib/electric/electricTestKit';
import { OrgContext, type OrgContextValue } from '@/shared/hooks/useOrgContext';
import { ProjectProvider } from '@/shared/providers/remote/ProjectProvider';
import { KanbanContainer } from './KanbanContainer';

/**
 * Renders the real KanbanContainer (ProjectProvider + real Electric-backed
 * collections, fake DOM) with every leaf UI component stubbed, and counts
 * KanbanCardContent renders per issue.
 */

// Shared by the hoisted vi.mock factories below, so hoisted with them.
const {
  contentRenders,
  passthrough,
  nothing,
  noop,
  EMPTY,
  HOST_MAP,
  APP_NAVIGATION,
  route,
  t,
} = vi.hoisted(() => ({
  contentRenders: vi.fn<(displayId: string) => void>(),
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
  t: (key: string, fallback?: string) =>
    typeof fallback === 'string' ? fallback : key,
}));

vi.mock('@tanstack/electric-db-collection', async () => {
  const kit = await import('@/shared/lib/electric/electricTestKit');
  return { electricCollectionOptions: kit.fakeElectricCollectionOptions };
});
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
    setDefaultCreateStatusId: noop,
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
  useIsActivePane: () => true,
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
vi.mock('@vibe/ui/components/KanbanBoard', () => ({
  KanbanProvider: passthrough,
  KanbanBoard: passthrough,
  KanbanCards: passthrough,
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
  contentRenders.mockClear();
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

async function renderBoard() {
  const projectId = `p${++projectCounter}`;
  route.projectId = projectId;
  const orgValue = {
    organizationId: 'org',
    projects: [{ id: projectId, name: 'Project', organization_id: 'org' }],
    isLoading: false,
    error: null,
    membersWithProfilesById: new Map([['u1', member]]),
  } as unknown as OrgContextValue;

  let bump: () => void = () => {};
  function Host() {
    const [, setTick] = useState(0);
    bump = () => setTick((tick) => tick + 1);
    return (
      <OrgContext.Provider value={orgValue}>
        <ProjectProvider projectId={projectId}>
          <KanbanContainer />
        </ProjectProvider>
      </OrgContext.Provider>
    );
  }
  await dom.render(<Host />);
  await act(() => emitSnapshotsByTable(seedRows(projectId)));
  await act(() => vi.advanceTimersByTimeAsync(0));

  return {
    projectId,
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
