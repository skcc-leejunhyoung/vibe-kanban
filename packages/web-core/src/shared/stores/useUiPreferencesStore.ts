import { useCallback, useMemo, useRef } from 'react';
import { create } from 'zustand';
import type { RepoAction } from '@vibe/ui/components/RepoCard';
import type { IssuePriority } from 'shared/remote-types';
import type { PreviewShortcutData } from 'shared/types';
import {
  BUILTIN_PRESET_IDS,
  DEFAULT_THEME_VARIANT,
  loadStoredPresets,
  mergePresets,
  persistStoredPresets,
  upsertPreset,
  type ThemePreset,
  type ThemeVariant,
} from '@/shared/lib/themePresets';
import {
  DEFAULT_RIGHT_SIDEBAR_SECTION_ORDER,
  normalizeRightSidebarSectionOrder,
  type RightSidebarSectionId,
} from '@/shared/lib/rightSidebarSections';

/**
 * Bucket key used to store preview shortcuts for workspaces that aren't
 * linked to a project (e.g. draft/standalone). Also receives migrated
 * legacy global shortcuts.
 */
export const PREVIEW_SHORTCUTS_GLOBAL_KEY = '__global';

export const RIGHT_MAIN_PANEL_MODES = {
  CHANGES: 'changes',
  LOGS: 'logs',
  PREVIEW: 'preview',
} as const;

export type RightMainPanelMode =
  (typeof RIGHT_MAIN_PANEL_MODES)[keyof typeof RIGHT_MAIN_PANEL_MODES];

export type LayoutMode = 'workspaces' | 'kanban';

export type MobileTab =
  | 'workspaces'
  | 'chat'
  | 'changes'
  | 'logs'
  | 'preview'
  | 'git';

export type MobileFontScale = 'default' | 'small' | 'smaller';
export const DEFAULT_CREATE_DRAFT_WORKSPACE_BY_DEFAULT = false;

const MOBILE_FONT_SCALE_KEY = 'vk-mobile-font-scale';

const loadMobileFontScale = (): MobileFontScale => {
  try {
    const stored = localStorage.getItem(MOBILE_FONT_SCALE_KEY);
    if (stored === 'small' || stored === 'smaller') return stored;
  } catch {
    // localStorage may be unavailable
  }
  return 'default';
};

// Theme variant ("skin") is a client-side visual preference applied on top of
// the Light/Dark/System mode. 'default' means no extra skin (the built-in
// look); other values select a theme preset (built-in or user-defined) whose
// design-token overrides are injected as a scoped <style>. Applied on both the
// local and remote web (settings picker + apply hook), with the selection and
// presets synced through config. The preset catalogue, persistence, and CSS
// generation live in shared/lib/themePresets.ts.
export { DEFAULT_THEME_VARIANT };
export type { ThemeVariant, ThemePreset };

const THEME_VARIANT_KEY = 'vk-theme-variant';

const loadThemeVariant = (): ThemeVariant => {
  try {
    const stored = localStorage.getItem(THEME_VARIANT_KEY);
    if (stored && stored !== DEFAULT_THEME_VARIANT) return stored;
  } catch {
    // localStorage may be unavailable
  }
  return DEFAULT_THEME_VARIANT;
};

export type KanbanViewMode = 'kanban' | 'list';

export type ContextBarPosition =
  | 'top-left'
  | 'top-right'
  | 'middle-left'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-right';

// Workspace-specific panel state
export type WorkspacePanelState = {
  rightMainPanelMode: RightMainPanelMode | null;
  isLeftMainPanelVisible: boolean;
};

const DEFAULT_WORKSPACE_PANEL_STATE: WorkspacePanelState = {
  rightMainPanelMode: null,
  isLeftMainPanelVisible: true,
};

// Kanban filter state
export type KanbanSortField =
  | 'sort_order'
  | 'priority'
  | 'created_at'
  | 'updated_at'
  | 'title';

export type KanbanFilterState = {
  searchQuery: string;
  priorities: IssuePriority[];
  assigneeIds: string[]; // 'unassigned' or '__self__' or user IDs
  tagIds: string[];
  sortField: KanbanSortField;
  sortDirection: 'asc' | 'desc';
};

export const DEFAULT_KANBAN_FILTER_STATE: KanbanFilterState = {
  searchQuery: '',
  priorities: [],
  assigneeIds: [],
  tagIds: [],
  sortField: 'sort_order',
  sortDirection: 'asc',
};

export const KANBAN_ASSIGNEE_FILTER_VALUES = {
  UNASSIGNED: 'unassigned',
  SELF: '__self__',
} as const;

export const DEFAULT_KANBAN_SHOW_WORKSPACES = true;
export const DEFAULT_KANBAN_HIDE_BLOCKED = false;

export type KanbanProjectViewSelection = {
  activeViewId: string;
};

// Transient per-view runtime override, layered on top of a view's configured
// default (the ProjectViewDefinition edited in settings). The project-page
// toolbar writes a full snapshot here so a view's saved default is never
// mutated by ad-hoc filtering; "Clear filters" deletes the override to reveal
// the view's configured default again. Keyed by project id then view id.
export type KanbanProjectViewPreferences = {
  filters: KanbanFilterState;
  showSubIssues: boolean;
  showWorkspaces: boolean;
  hideBlocked: boolean;
};

const cloneKanbanFilters = (filters: KanbanFilterState): KanbanFilterState => ({
  searchQuery: filters.searchQuery,
  priorities: [...filters.priorities],
  assigneeIds: [...filters.assigneeIds],
  tagIds: [...filters.tagIds],
  sortField: filters.sortField,
  sortDirection: filters.sortDirection,
});

// --- User-defined project views -------------------------------------------
// A project view unifies the old Active/All/hidden-status tabs and the
// Team/Personal filter presets into a single editable object: a layout
// (kanban board vs. table), an ordered set of status groups, and default
// filters/sort/toggles. Views are per-project, persisted via the UI
// preferences scratch. Built-in defaults are derived from the project's
// statuses when a project has no stored views yet, and materialized on first
// edit.
export type ProjectViewLayout = 'kanban' | 'table';

export type ProjectViewDefinition = {
  id: string;
  name: string;
  layout: ProjectViewLayout;
  /**
   * Ordered status IDs shown as groups. `null` uses the default grouping
   * (kanban: non-hidden statuses; table: all statuses).
   */
  groupStatusIds: string[] | null;
  filters: KanbanFilterState;
  showSubIssues: boolean;
  showWorkspaces: boolean;
  hideBlocked: boolean;
};

export const DEFAULT_PROJECT_VIEW_IDS = {
  ACTIVE: 'active',
  ALL: 'all',
} as const;

/** Stable id for a built-in per-hidden-status view (Backlog, Cancelled, …). */
export const buildStatusViewId = (statusId: string): string =>
  `status:${statusId}`;

export type ProjectViewStatusInput = {
  id: string;
  name: string;
  hidden: boolean;
};

/**
 * Reproduces the previous fixed tabs as editable views: Active (kanban, all
 * non-hidden columns), All (table, every status), and one table view per hidden
 * status (Backlog, Cancelled, …).
 */
export const buildDefaultProjectViews = (
  statuses: ProjectViewStatusInput[],
  labels: { active: string; all: string }
): ProjectViewDefinition[] => {
  const baseToggles = {
    showSubIssues: true,
    showWorkspaces: DEFAULT_KANBAN_SHOW_WORKSPACES,
    hideBlocked: DEFAULT_KANBAN_HIDE_BLOCKED,
  };
  const views: ProjectViewDefinition[] = [
    {
      id: DEFAULT_PROJECT_VIEW_IDS.ACTIVE,
      name: labels.active,
      layout: 'kanban',
      groupStatusIds: null,
      filters: cloneKanbanFilters(DEFAULT_KANBAN_FILTER_STATE),
      ...baseToggles,
    },
    {
      id: DEFAULT_PROJECT_VIEW_IDS.ALL,
      name: labels.all,
      layout: 'table',
      groupStatusIds: null,
      filters: cloneKanbanFilters(DEFAULT_KANBAN_FILTER_STATE),
      ...baseToggles,
    },
  ];
  for (const status of statuses) {
    if (!status.hidden) continue;
    views.push({
      id: buildStatusViewId(status.id),
      name: status.name,
      layout: 'table',
      groupStatusIds: [status.id],
      filters: cloneKanbanFilters(DEFAULT_KANBAN_FILTER_STATE),
      ...baseToggles,
    });
  }
  return views;
};

// Workspace sidebar filter state
export type WorkspacePrFilter = 'all' | 'has_pr' | 'no_pr';
// Coarse workspace activity buckets, mirrored from @vibe/ui
// (getWorkspaceActivityStatus). Empty selection = no status filtering.
export type WorkspaceActivityStatus = 'running' | 'attention' | 'idle';
export type WorkspaceSortBy = 'updated_at' | 'created_at';
export type WorkspaceSortOrder = 'asc' | 'desc';

// How the workspace sidebar groups its rows. 'workspace' keeps the original
// behaviour (flat list, or accordion by run state); 'issue' groups workspaces
// under the remote issue they're linked to.
export type WorkspaceGroupMode = 'workspace' | 'issue';

export const DEFAULT_WORKSPACE_GROUP_MODE: WorkspaceGroupMode = 'workspace';

// Status names shown (and their order) when grouping workspaces by issue with
// the status-accordion enabled. An issue whose status name doesn't match any of
// these falls into the "unknown" bucket. Names are matched case-insensitively.
export const DEFAULT_WORKSPACE_ISSUE_STATUSES = [
  'To do',
  'In progress',
  'In review',
  'Done',
];

const WORKSPACE_GROUP_MODE_KEY = 'vk-workspace-group-mode';
const WORKSPACE_ISSUE_STATUSES_KEY = 'vk-workspace-issue-statuses';

const loadWorkspaceGroupMode = (): WorkspaceGroupMode => {
  try {
    const stored = localStorage.getItem(WORKSPACE_GROUP_MODE_KEY);
    if (stored === 'issue' || stored === 'workspace') return stored;
  } catch {
    // localStorage may be unavailable
  }
  return DEFAULT_WORKSPACE_GROUP_MODE;
};

const loadWorkspaceIssueStatuses = (): string[] => {
  try {
    const stored = localStorage.getItem(WORKSPACE_ISSUE_STATUSES_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (
        Array.isArray(parsed) &&
        parsed.every((entry) => typeof entry === 'string')
      ) {
        return parsed;
      }
    }
  } catch {
    // localStorage unavailable or malformed JSON
  }
  return [...DEFAULT_WORKSPACE_ISSUE_STATUSES];
};

// Per-agent set of model keys hidden from the model selector. A model key is
// `provider_id/id` (or just `id` when there's no provider), matching
// getModelKey(). Purely a client-side display preference — the backend still
// offers every model; the picker just filters what it renders.
const HIDDEN_MODELS_KEY = 'vk-hidden-models';
const EMPTY_MODEL_KEYS: string[] = [];

const loadHiddenModels = (): Record<string, string[]> => {
  try {
    const stored = localStorage.getItem(HIDDEN_MODELS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string[]> = {};
        for (const [agent, keys] of Object.entries(parsed)) {
          if (Array.isArray(keys)) {
            const valid = keys.filter(
              (k): k is string => typeof k === 'string'
            );
            if (valid.length > 0) out[agent] = valid;
          }
        }
        return out;
      }
    }
  } catch {
    // localStorage unavailable or malformed JSON
  }
  return {};
};

const persistHiddenModels = (value: Record<string, string[]>) => {
  try {
    const pruned = Object.fromEntries(
      Object.entries(value).filter(([, keys]) => keys.length > 0)
    );
    if (Object.keys(pruned).length === 0) {
      localStorage.removeItem(HIDDEN_MODELS_KEY);
    } else {
      localStorage.setItem(HIDDEN_MODELS_KEY, JSON.stringify(pruned));
    }
  } catch {
    // localStorage unavailable
  }
};

export type WorkspaceFilterState = {
  projectIds: string[]; // remote project IDs
  prFilter: WorkspacePrFilter;
  statusFilters: WorkspaceActivityStatus[]; // empty = all statuses
  excludedHostIds: string[]; // '__local__' represents this machine
};

export type WorkspaceSortState = {
  sortBy: WorkspaceSortBy;
  sortOrder: WorkspaceSortOrder;
};

const DEFAULT_WORKSPACE_FILTER_STATE: WorkspaceFilterState = {
  projectIds: [],
  prFilter: 'all',
  statusFilters: [],
  excludedHostIds: [],
};

const DEFAULT_WORKSPACE_SORT_STATE: WorkspaceSortState = {
  sortBy: 'updated_at',
  sortOrder: 'desc',
};

// Centralized persist keys for type safety
export const PERSIST_KEYS = {
  // Sidebar sections
  workspacesSidebarArchived: 'workspaces-sidebar-archived',
  // v2 key forces accordion default to true for all users
  workspacesSidebarAccordionLayout: 'workspaces-sidebar-accordion-layout-v2',
  workspacesSidebarRaisedHand: 'workspaces-sidebar-raised-hand',
  workspacesSidebarNotRunning: 'workspaces-sidebar-not-running',
  workspacesSidebarRunning: 'workspaces-sidebar-running',
  // Right panel sections
  gitAdvancedSettings: 'git-advanced-settings',
  gitPanelRepositories: 'git-panel-repositories',
  gitPanelProject: 'git-panel-project',
  gitPanelAddRepositories: 'git-panel-add-repositories',
  // Pull requests panel section
  pullRequestsSection: 'pull-requests-section',
  commitsSection: 'commits-section',
  rightPanelprocesses: 'right-panel-processes',
  rightPanelPreview: 'right-panel-preview',
  // Process panel sections
  processesSection: 'processes-section',
  // Changes panel sections
  changesSection: 'changes-section',
  // Preview panel sections
  devServerSection: 'dev-server-section',
  // Terminal panel section
  terminalSection: 'terminal-section',
  // Notes panel section
  notesSection: 'notes-section',
  // GitHub comments toggle
  showGitHubComments: 'show-github-comments',
  // Panel sizes
  rightMainPanel: 'right-main-panel',
  kanbanLeftPanel: 'kanban-left-panel',
  // Kanban issue panel sections
  kanbanIssueSubIssues: 'kanban-issue-sub-issues',
  kanbanIssueRelationships: 'kanban-issue-relationships',
  kanbanIssueAttachments: 'kanban-issue-attachments',
  // Dynamic keys (use helper functions)
  repoCard: (repoId: string) => `repo-card-${repoId}` as const,
} as const;

// Check if screen is wide enough to keep sidebar visible
const isWideScreen = () => window.innerWidth > 2048;

export type PersistKey =
  | typeof PERSIST_KEYS.workspacesSidebarArchived
  | typeof PERSIST_KEYS.workspacesSidebarAccordionLayout
  | typeof PERSIST_KEYS.workspacesSidebarRaisedHand
  | typeof PERSIST_KEYS.workspacesSidebarNotRunning
  | typeof PERSIST_KEYS.workspacesSidebarRunning
  | typeof PERSIST_KEYS.gitAdvancedSettings
  | typeof PERSIST_KEYS.gitPanelRepositories
  | typeof PERSIST_KEYS.gitPanelProject
  | typeof PERSIST_KEYS.gitPanelAddRepositories
  | typeof PERSIST_KEYS.pullRequestsSection
  | typeof PERSIST_KEYS.commitsSection
  | typeof PERSIST_KEYS.processesSection
  | typeof PERSIST_KEYS.changesSection
  | typeof PERSIST_KEYS.devServerSection
  | typeof PERSIST_KEYS.terminalSection
  | typeof PERSIST_KEYS.notesSection
  | typeof PERSIST_KEYS.showGitHubComments
  | typeof PERSIST_KEYS.rightMainPanel
  | typeof PERSIST_KEYS.rightPanelprocesses
  | typeof PERSIST_KEYS.rightPanelPreview
  | typeof PERSIST_KEYS.kanbanLeftPanel
  | typeof PERSIST_KEYS.kanbanIssueSubIssues
  | typeof PERSIST_KEYS.kanbanIssueRelationships
  | typeof PERSIST_KEYS.kanbanIssueAttachments
  | `repo-card-${string}`
  | `diff:${string}`
  | `edit:${string}`
  | `plan:${string}`
  | `tool:${string}`
  | `todo:${string}`
  | `subagent:${string}`
  | `user:${string}`
  | `system:${string}`
  | `error:${string}`
  | `entry:${string}`
  | `list-section-${string}`;

type State = {
  // UI preferences
  repoActions: Record<string, RepoAction>;
  expanded: Record<string, boolean>;
  contextBarPosition: ContextBarPosition;
  paneSizes: Record<string, number | string>;
  collapsedPaths: Record<string, string[]>;
  fileSearchRepoId: string | null;

  // Global layout state (applies across all workspaces)
  layoutMode: LayoutMode;
  isLeftSidebarVisible: boolean;
  isRightSidebarVisible: boolean;
  isTerminalVisible: boolean;
  rightSidebarSectionOrder: RightSidebarSectionId[];
  previewRefreshKey: number;
  // Note: Kanban issue panel state (selectedKanbanIssueId, createMode, etc.)
  // is derived from URL via app navigation route state

  // Workspace-specific panel state
  workspacePanelStates: Record<string, WorkspacePanelState>;

  // Selected kanban view per project (built-in or user-defined view id)
  kanbanProjectViewSelections: Record<string, KanbanProjectViewSelection>;

  // User-defined view definitions per project. Empty/absent => derived defaults.
  projectViewsById: Record<string, ProjectViewDefinition[]>;

  // Transient per-view toolbar overrides layered over the view's configured
  // default, per project then view id. Absent => the view's default is in use.
  kanbanProjectViewPreferences: Record<
    string,
    Record<string, KanbanProjectViewPreferences>
  >;

  // Collapsed status-group ids per project (kanban table/list view).
  collapsedGroupsByProject: Record<string, string[]>;

  // Preview browser shortcuts keyed by project id. Workspaces with no
  // associated project use PREVIEW_SHORTCUTS_GLOBAL_KEY.
  previewShortcutsByProject: Record<string, PreviewShortcutData[]>;

  // Workspace sidebar filter state
  workspaceFilters: WorkspaceFilterState;
  workspaceSort: WorkspaceSortState;

  // Workspace sidebar grouping mode (by run state vs. by issue)
  workspaceGroupMode: WorkspaceGroupMode;
  // Status names (ordered) used when grouping the issue view by status
  workspaceIssueStatuses: string[];

  // Per-agent hidden model keys (model selector visibility preference)
  hiddenModelsByAgent: Record<string, string[]>;

  // Mobile tab state
  mobileActiveTab: MobileTab;

  // Mobile font scale
  mobileFontScale: MobileFontScale;

  // Theme variant ("skin"), applied on top of the light/dark mode
  themeVariant: ThemeVariant;

  // User-added presets + overrides of built-in presets (persisted locally).
  // The effective list (built-ins merged with these) is derived via the
  // useThemePresets() hook.
  customThemePresets: ThemePreset[];

  // Last selected organization and project (persisted via scratch store)
  selectedOrgId: string | null;
  selectedProjectId: string | null;
  createDraftWorkspaceByDefault: boolean;

  // UI preferences actions
  setRepoAction: (repoId: string, action: RepoAction) => void;
  setExpanded: (key: string, value: boolean) => void;
  toggleExpanded: (key: string, defaultValue?: boolean) => void;
  setExpandedAll: (keys: string[], value: boolean) => void;
  setContextBarPosition: (position: ContextBarPosition) => void;
  setPaneSize: (key: string, size: number | string) => void;
  setCollapsedPaths: (key: string, paths: string[]) => void;
  setFileSearchRepo: (repoId: string | null) => void;

  // Layout actions
  setLayoutMode: (mode: LayoutMode) => void;
  toggleLayoutMode: () => void;
  toggleLeftSidebar: () => void;
  toggleLeftMainPanel: (workspaceId?: string) => void;
  toggleRightSidebar: () => void;
  toggleTerminal: () => void;
  setTerminalVisible: (value: boolean) => void;
  setRightSidebarSectionOrder: (order: RightSidebarSectionId[]) => void;
  // Note: Kanban panel actions (openKanbanIssuePanel, closeKanbanIssuePanel, etc.)
  // are handled by app navigation
  toggleRightMainPanelMode: (
    mode: RightMainPanelMode,
    workspaceId?: string
  ) => void;
  setRightMainPanelMode: (
    mode: RightMainPanelMode | null,
    workspaceId?: string
  ) => void;
  setLeftSidebarVisible: (value: boolean) => void;
  setLeftMainPanelVisible: (value: boolean, workspaceId?: string) => void;
  triggerPreviewRefresh: () => void;

  // Workspace-specific panel state actions
  getWorkspacePanelState: (workspaceId: string) => WorkspacePanelState;
  setWorkspacePanelState: (
    workspaceId: string,
    state: Partial<WorkspacePanelState>
  ) => void;

  // Kanban view selection actions
  setKanbanProjectView: (projectId: string, viewId: string) => void;
  // Replace the full ordered view list for a project (CRUD + reorder + materialize)
  setProjectViews: (projectId: string, views: ProjectViewDefinition[]) => void;
  // Toolbar override actions: set/clear the transient per-view runtime override.
  setKanbanProjectViewPreferences: (
    projectId: string,
    viewId: string,
    preferences: KanbanProjectViewPreferences
  ) => void;
  clearKanbanProjectViewPreferences: (
    projectId: string,
    viewId: string
  ) => void;
  // Replace the collapsed status-group id list for a project (table view).
  setCollapsedGroups: (projectId: string, statusIds: string[]) => void;
  setPreviewShortcuts: (
    projectKey: string,
    shortcuts: PreviewShortcutData[]
  ) => void;

  // Workspace sidebar filter actions
  setWorkspaceProjectFilter: (projectIds: string[]) => void;
  setWorkspacePrFilter: (prFilter: WorkspacePrFilter) => void;
  setWorkspaceStatusFilter: (statusFilters: WorkspaceActivityStatus[]) => void;
  setWorkspaceHostFilter: (excludedHostIds: string[]) => void;
  clearWorkspaceFilters: () => void;
  setWorkspaceSortBy: (sortBy: WorkspaceSortBy) => void;
  setWorkspaceSortOrder: (sortOrder: WorkspaceSortOrder) => void;

  // Workspace sidebar grouping actions
  setWorkspaceGroupMode: (mode: WorkspaceGroupMode) => void;
  toggleWorkspaceGroupMode: () => void;
  setWorkspaceIssueStatuses: (statuses: string[]) => void;

  // Model visibility actions
  setModelHidden: (agent: string, modelKey: string, hidden: boolean) => void;

  // Mobile tab actions
  setMobileActiveTab: (tab: MobileTab) => void;

  // Mobile font scale actions
  setMobileFontScale: (scale: MobileFontScale) => void;

  // Theme variant actions
  setThemeVariant: (variant: ThemeVariant) => void;
  // Insert or update a preset (matched by id). Built-in ids become overrides.
  saveThemePreset: (preset: ThemePreset) => void;
  // Remove a custom preset, or reset a built-in override back to its default.
  deleteThemePreset: (id: string) => void;

  // Last selected organization and project actions
  setSelectedOrgId: (orgId: string | null) => void;
  clearSelectedOrgId: () => void;
  setSelectedProjectId: (projectId: string | null) => void;
  setCreateDraftWorkspaceByDefault: (value: boolean) => void;
};

export const useUiPreferencesStore = create<State>()((set, get) => ({
  // UI preferences state
  repoActions: {},
  expanded: {},
  contextBarPosition: 'middle-right',
  paneSizes: {},
  collapsedPaths: {},
  fileSearchRepoId: null,

  // Global layout state
  layoutMode: 'workspaces' as LayoutMode,
  isLeftSidebarVisible: true,
  isRightSidebarVisible: true,
  isTerminalVisible: true,
  rightSidebarSectionOrder: DEFAULT_RIGHT_SIDEBAR_SECTION_ORDER,
  previewRefreshKey: 0,

  // Workspace-specific panel state
  workspacePanelStates: {},

  // Kanban per-project view selection
  kanbanProjectViewSelections: {},
  projectViewsById: {},
  kanbanProjectViewPreferences: {},
  collapsedGroupsByProject: {},
  previewShortcutsByProject: {},

  // Workspace sidebar filter state
  workspaceFilters: DEFAULT_WORKSPACE_FILTER_STATE,
  workspaceSort: DEFAULT_WORKSPACE_SORT_STATE,

  // Workspace sidebar grouping
  workspaceGroupMode: loadWorkspaceGroupMode(),
  workspaceIssueStatuses: loadWorkspaceIssueStatuses(),

  // Model visibility
  hiddenModelsByAgent: loadHiddenModels(),

  // Mobile tab state
  mobileActiveTab: 'chat' as MobileTab,

  // Mobile font scale
  mobileFontScale: loadMobileFontScale(),

  // Theme variant
  themeVariant: loadThemeVariant(),
  customThemePresets: loadStoredPresets(),

  // Last selected organization and project
  selectedOrgId: null,
  selectedProjectId: null,
  createDraftWorkspaceByDefault: DEFAULT_CREATE_DRAFT_WORKSPACE_BY_DEFAULT,

  // UI preferences actions
  setRepoAction: (repoId, action) =>
    set((s) => ({ repoActions: { ...s.repoActions, [repoId]: action } })),
  setExpanded: (key, value) =>
    set((s) => ({ expanded: { ...s.expanded, [key]: value } })),
  toggleExpanded: (key, defaultValue = true) =>
    set((s) => ({
      expanded: {
        ...s.expanded,
        [key]: !(s.expanded[key] ?? defaultValue),
      },
    })),
  setExpandedAll: (keys, value) =>
    set((s) => ({
      expanded: {
        ...s.expanded,
        ...Object.fromEntries(keys.map((k) => [k, value])),
      },
    })),
  setContextBarPosition: (position) => set({ contextBarPosition: position }),
  setPaneSize: (key, size) =>
    set((s) => ({ paneSizes: { ...s.paneSizes, [key]: size } })),
  setCollapsedPaths: (key, paths) =>
    set((s) => ({ collapsedPaths: { ...s.collapsedPaths, [key]: paths } })),
  setFileSearchRepo: (repoId) => set({ fileSearchRepoId: repoId }),

  // Layout actions
  setLayoutMode: (mode) => set({ layoutMode: mode }),
  toggleLayoutMode: () =>
    set((s) => ({
      layoutMode: s.layoutMode === 'workspaces' ? 'kanban' : 'workspaces',
    })),
  toggleLeftSidebar: () =>
    set((s) => ({ isLeftSidebarVisible: !s.isLeftSidebarVisible })),

  toggleLeftMainPanel: (workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    if (wsState.isLeftMainPanelVisible && wsState.rightMainPanelMode === null)
      return;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          isLeftMainPanelVisible: !wsState.isLeftMainPanelVisible,
        },
      },
    });
  },

  toggleRightSidebar: () =>
    set((s) => ({ isRightSidebarVisible: !s.isRightSidebarVisible })),

  toggleTerminal: () =>
    set((s) => ({ isTerminalVisible: !s.isTerminalVisible })),

  setTerminalVisible: (value) => set({ isTerminalVisible: value }),
  setRightSidebarSectionOrder: (order) =>
    set({
      rightSidebarSectionOrder: normalizeRightSidebarSectionOrder(order),
    }),

  toggleRightMainPanelMode: (mode, workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    const isCurrentlyActive = wsState.rightMainPanelMode === mode;
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          rightMainPanelMode: isCurrentlyActive ? null : mode,
        },
      },
      isLeftSidebarVisible: isCurrentlyActive
        ? true
        : isWideScreen()
          ? state.isLeftSidebarVisible
          : false,
      ...(isMobile &&
        !isCurrentlyActive && { mobileActiveTab: mode as MobileTab }),
    });
  },

  setRightMainPanelMode: (mode, workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          rightMainPanelMode: mode,
        },
      },
      ...(mode !== null && {
        isLeftSidebarVisible: isWideScreen()
          ? state.isLeftSidebarVisible
          : false,
      }),
      ...(isMobile && mode !== null && { mobileActiveTab: mode as MobileTab }),
    });
  },

  setLeftSidebarVisible: (value) => set({ isLeftSidebarVisible: value }),

  setLeftMainPanelVisible: (value, workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          isLeftMainPanelVisible: value,
        },
      },
    });
  },

  triggerPreviewRefresh: () =>
    set((s) => ({ previewRefreshKey: s.previewRefreshKey + 1 })),

  // Workspace-specific panel state actions
  getWorkspacePanelState: (workspaceId) => {
    const state = get();
    return (
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE
    );
  },

  setWorkspacePanelState: (workspaceId, panelState) => {
    const state = get();
    const currentWsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...currentWsState,
          ...panelState,
        },
      },
    });
  },

  // Kanban view selection actions. View ids are now arbitrary (built-in or
  // user-defined), so no membership guard here — the container falls back to
  // the first view when a stored id no longer resolves.
  setKanbanProjectView: (projectId, viewId) => {
    set((s) => ({
      kanbanProjectViewSelections: {
        ...s.kanbanProjectViewSelections,
        [projectId]: { activeViewId: viewId },
      },
    }));
  },

  setProjectViews: (projectId, views) =>
    set((s) => ({
      projectViewsById: {
        ...s.projectViewsById,
        [projectId]: views,
      },
    })),

  setKanbanProjectViewPreferences: (projectId, viewId, preferences) =>
    set((s) => ({
      kanbanProjectViewPreferences: {
        ...s.kanbanProjectViewPreferences,
        [projectId]: {
          ...s.kanbanProjectViewPreferences[projectId],
          [viewId]: {
            filters: cloneKanbanFilters(preferences.filters),
            showSubIssues: preferences.showSubIssues,
            showWorkspaces: preferences.showWorkspaces,
            hideBlocked: preferences.hideBlocked,
          },
        },
      },
    })),

  clearKanbanProjectViewPreferences: (projectId, viewId) =>
    set((s) => {
      const projectPreferences = s.kanbanProjectViewPreferences[projectId];
      if (!projectPreferences || !(viewId in projectPreferences)) {
        return {};
      }
      const nextProjectPreferences = { ...projectPreferences };
      delete nextProjectPreferences[viewId];
      const next = { ...s.kanbanProjectViewPreferences };
      if (Object.keys(nextProjectPreferences).length === 0) {
        delete next[projectId];
      } else {
        next[projectId] = nextProjectPreferences;
      }
      return { kanbanProjectViewPreferences: next };
    }),

  setCollapsedGroups: (projectId, statusIds) =>
    set((s) => ({
      collapsedGroupsByProject: {
        ...s.collapsedGroupsByProject,
        [projectId]: statusIds,
      },
    })),

  setPreviewShortcuts: (projectKey, shortcuts) =>
    set((s) => ({
      previewShortcutsByProject: {
        ...s.previewShortcutsByProject,
        [projectKey]: shortcuts,
      },
    })),

  // Workspace sidebar filter actions
  setWorkspaceProjectFilter: (projectIds) =>
    set((s) => ({
      workspaceFilters: { ...s.workspaceFilters, projectIds },
    })),

  setWorkspacePrFilter: (prFilter) =>
    set((s) => ({
      workspaceFilters: { ...s.workspaceFilters, prFilter },
    })),

  setWorkspaceStatusFilter: (statusFilters) =>
    set((s) => ({
      workspaceFilters: { ...s.workspaceFilters, statusFilters },
    })),
  setWorkspaceHostFilter: (excludedHostIds) =>
    set((s) => ({
      workspaceFilters: { ...s.workspaceFilters, excludedHostIds },
    })),

  clearWorkspaceFilters: () =>
    set({ workspaceFilters: DEFAULT_WORKSPACE_FILTER_STATE }),

  setWorkspaceSortBy: (sortBy) =>
    set((s) => ({
      workspaceSort: { ...s.workspaceSort, sortBy },
    })),

  setWorkspaceSortOrder: (sortOrder) =>
    set((s) => ({
      workspaceSort: { ...s.workspaceSort, sortOrder },
    })),

  // Workspace sidebar grouping actions
  setWorkspaceGroupMode: (mode) => {
    try {
      if (mode === DEFAULT_WORKSPACE_GROUP_MODE) {
        localStorage.removeItem(WORKSPACE_GROUP_MODE_KEY);
      } else {
        localStorage.setItem(WORKSPACE_GROUP_MODE_KEY, mode);
      }
    } catch {
      // localStorage may be unavailable
    }
    set({ workspaceGroupMode: mode });
  },

  toggleWorkspaceGroupMode: () =>
    set((s) => {
      const next: WorkspaceGroupMode =
        s.workspaceGroupMode === 'issue' ? 'workspace' : 'issue';
      try {
        if (next === DEFAULT_WORKSPACE_GROUP_MODE) {
          localStorage.removeItem(WORKSPACE_GROUP_MODE_KEY);
        } else {
          localStorage.setItem(WORKSPACE_GROUP_MODE_KEY, next);
        }
      } catch {
        // localStorage may be unavailable
      }
      return { workspaceGroupMode: next };
    }),

  setWorkspaceIssueStatuses: (statuses) => {
    try {
      localStorage.setItem(
        WORKSPACE_ISSUE_STATUSES_KEY,
        JSON.stringify(statuses)
      );
    } catch {
      // localStorage may be unavailable
    }
    set({ workspaceIssueStatuses: statuses });
  },

  // Model visibility actions
  setModelHidden: (agent, modelKey, hidden) =>
    set((s) => {
      const current = s.hiddenModelsByAgent[agent] ?? EMPTY_MODEL_KEYS;
      const keyLower = modelKey.toLowerCase();
      const filtered = current.filter((k) => k.toLowerCase() !== keyLower);
      const nextList = hidden ? [...filtered, modelKey] : filtered;
      const next = { ...s.hiddenModelsByAgent };
      if (nextList.length > 0) {
        next[agent] = nextList;
      } else {
        delete next[agent];
      }
      persistHiddenModels(next);
      return { hiddenModelsByAgent: next };
    }),

  // Mobile tab actions
  setMobileActiveTab: (tab) => set({ mobileActiveTab: tab }),

  // Mobile font scale actions
  setMobileFontScale: (scale) => {
    try {
      if (scale === 'default') {
        localStorage.removeItem(MOBILE_FONT_SCALE_KEY);
      } else {
        localStorage.setItem(MOBILE_FONT_SCALE_KEY, scale);
      }
    } catch {
      // localStorage may be unavailable
    }
    set({ mobileFontScale: scale });
  },

  // Theme variant actions
  setThemeVariant: (variant) => {
    try {
      if (variant === DEFAULT_THEME_VARIANT) {
        localStorage.removeItem(THEME_VARIANT_KEY);
      } else {
        localStorage.setItem(THEME_VARIANT_KEY, variant);
      }
    } catch {
      // localStorage may be unavailable
    }
    set({ themeVariant: variant });
  },

  saveThemePreset: (preset) =>
    set((s) => {
      // Upsert in place so editing a preset doesn't reorder the list (autosave
      // fires per keystroke). New presets are appended.
      const next = upsertPreset(s.customThemePresets, preset);
      persistStoredPresets(next);
      return { customThemePresets: next };
    }),

  deleteThemePreset: (id) =>
    set((s) => {
      const next = s.customThemePresets.filter((p) => p.id !== id);
      persistStoredPresets(next);
      // If the removed preset was selected, fall back to the default skin.
      // (Resetting a built-in override keeps it selected — it still resolves
      // to the built-in default — so only clear when nothing resolves to it.)
      const stillExists =
        BUILTIN_PRESET_IDS.has(id) ||
        next.some((p) => p.id === id) ||
        id === DEFAULT_THEME_VARIANT;
      if (s.themeVariant === id && !stillExists) {
        try {
          localStorage.removeItem(THEME_VARIANT_KEY);
        } catch {
          // localStorage may be unavailable
        }
        return {
          customThemePresets: next,
          themeVariant: DEFAULT_THEME_VARIANT,
        };
      }
      return { customThemePresets: next };
    }),

  // Last selected organization and project actions
  setSelectedOrgId: (orgId) => set({ selectedOrgId: orgId }),
  clearSelectedOrgId: () => set({ selectedOrgId: null }),
  setSelectedProjectId: (projectId) => set({ selectedProjectId: projectId }),
  setCreateDraftWorkspaceByDefault: (value) =>
    set({ createDraftWorkspaceByDefault: value }),
}));

// Hook for repo action preference
export function useRepoAction(
  repoId: string,
  defaultAction: RepoAction = 'pull-request'
): [RepoAction, (action: RepoAction) => void] {
  const action = useUiPreferencesStore(
    (s) => s.repoActions[repoId] ?? defaultAction
  );
  const setAction = useUiPreferencesStore((s) => s.setRepoAction);
  return [action, (a) => setAction(repoId, a)];
}

// Hook for persisted expanded state
export function usePersistedExpanded(
  key: PersistKey,
  defaultValue = true
): [boolean, (value?: boolean) => void] {
  const expanded = useUiPreferencesStore(
    (s) => s.expanded[key] ?? defaultValue
  );
  const setExpanded = useUiPreferencesStore((s) => s.setExpanded);
  const toggleExpanded = useUiPreferencesStore((s) => s.toggleExpanded);

  const set = (value?: boolean) => {
    if (typeof value === 'boolean') setExpanded(key, value);
    else toggleExpanded(key, defaultValue);
  };

  return [expanded, set];
}

// Hook for context bar position
export function useContextBarPosition(): [
  ContextBarPosition,
  (position: ContextBarPosition) => void,
] {
  const position = useUiPreferencesStore((s) => s.contextBarPosition);
  const setPosition = useUiPreferencesStore((s) => s.setContextBarPosition);
  return [position, setPosition];
}

// Hook for pane size preference
export function usePaneSize(
  key: PersistKey,
  defaultSize: number | string
): [number | string, (size: number | string) => void] {
  const size = useUiPreferencesStore((s) => s.paneSizes[key] ?? defaultSize);
  const setSize = useUiPreferencesStore((s) => s.setPaneSize);
  return [size, (s) => setSize(key, s)];
}

// Hook for bulk expanded state operations
export function useExpandedAll() {
  const expanded = useUiPreferencesStore((s) => s.expanded);
  const setExpanded = useUiPreferencesStore((s) => s.setExpanded);
  const setExpandedAll = useUiPreferencesStore((s) => s.setExpandedAll);
  return { expanded, setExpanded, setExpandedAll };
}

// Hook for persisted file tree collapsed paths (per workspace)
export function usePersistedCollapsedPaths(
  workspaceId: string | undefined
): [
  Set<string>,
  (paths: Set<string> | ((prev: Set<string>) => Set<string>)) => void,
] {
  const key = workspaceId ? `file-tree:${workspaceId}` : '';
  const paths = useUiPreferencesStore((s) => s.collapsedPaths[key] ?? []);
  const setPaths = useUiPreferencesStore((s) => s.setCollapsedPaths);

  const pathSet = useMemo(() => new Set(paths), [paths]);
  const pathSetRef = useRef(pathSet);
  pathSetRef.current = pathSet;

  const setPathSet = useCallback(
    (newPaths: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      if (!key) return;
      const resolved =
        typeof newPaths === 'function'
          ? newPaths(pathSetRef.current)
          : newPaths;
      setPaths(key, [...resolved]);
    },
    [key, setPaths]
  );

  return [pathSet, setPathSet];
}

// Hook for mobile active tab
export function useMobileActiveTab() {
  const tab = useUiPreferencesStore((s) => s.mobileActiveTab);
  const set = useUiPreferencesStore((s) => s.setMobileActiveTab);
  return [tab, set] as const;
}

// Hook for mobile font scale
export function useMobileFontScale() {
  const scale = useUiPreferencesStore((s) => s.mobileFontScale);
  const set = useUiPreferencesStore((s) => s.setMobileFontScale);
  return [scale, set] as const;
}

// Hook for theme variant ("skin")
export function useThemeVariant() {
  const variant = useUiPreferencesStore((s) => s.themeVariant);
  const set = useUiPreferencesStore((s) => s.setThemeVariant);
  return [variant, set] as const;
}

// Hook for the workspace sidebar grouping mode (run-state vs. issue)
export function useWorkspaceGroupMode() {
  const mode = useUiPreferencesStore((s) => s.workspaceGroupMode);
  const set = useUiPreferencesStore((s) => s.setWorkspaceGroupMode);
  const toggle = useUiPreferencesStore((s) => s.toggleWorkspaceGroupMode);
  return { mode, setMode: set, toggle };
}

// Hook for the ordered status names used to bucket the issue-grouped sidebar
export function useWorkspaceIssueStatuses() {
  const statuses = useUiPreferencesStore((s) => s.workspaceIssueStatuses);
  const set = useUiPreferencesStore((s) => s.setWorkspaceIssueStatuses);
  return [statuses, set] as const;
}

// Hook for per-agent model visibility. `hiddenKeys` holds lowercased model
// keys; `setHidden(key, hidden)` and `isHidden(key)` operate on the raw key.
export function useHiddenModels(agent: string | null) {
  const map = useUiPreferencesStore((s) => s.hiddenModelsByAgent);
  const setModelHidden = useUiPreferencesStore((s) => s.setModelHidden);
  const list = agent ? (map[agent] ?? EMPTY_MODEL_KEYS) : EMPTY_MODEL_KEYS;
  const hiddenKeys = useMemo(
    () => new Set(list.map((k) => k.toLowerCase())),
    [list]
  );
  const isHidden = useCallback(
    (key: string) => hiddenKeys.has(key.toLowerCase()),
    [hiddenKeys]
  );
  const setHidden = useCallback(
    (key: string, hidden: boolean) => {
      if (agent) setModelHidden(agent, key, hidden);
    },
    [agent, setModelHidden]
  );
  return { hiddenKeys, isHidden, setHidden };
}

// Hook returning the effective theme preset list (built-ins merged with the
// user's stored overrides/additions). Memoized on the raw custom presets so it
// only recomputes when those change.
export function useThemePresets(): ThemePreset[] {
  const custom = useUiPreferencesStore((s) => s.customThemePresets);
  return useMemo(() => mergePresets(custom), [custom]);
}

// Hook exposing the preset CRUD actions.
export function useThemePresetActions() {
  const save = useUiPreferencesStore((s) => s.saveThemePreset);
  const remove = useUiPreferencesStore((s) => s.deleteThemePreset);
  return { saveThemePreset: save, deleteThemePreset: remove };
}

// Hook for workspace-specific panel state
export function useWorkspacePanelState(workspaceId: string | undefined) {
  // Subscribe only to this workspace's panel state slice (not the entire map)
  const wsState = useUiPreferencesStore((s) =>
    workspaceId
      ? (s.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE)
      : DEFAULT_WORKSPACE_PANEL_STATE
  );

  // Global state (sidebars are global)
  const isLeftSidebarVisible = useUiPreferencesStore(
    (s) => s.isLeftSidebarVisible
  );
  const isRightSidebarVisible = useUiPreferencesStore(
    (s) => s.isRightSidebarVisible
  );
  const isTerminalVisible = useUiPreferencesStore((s) => s.isTerminalVisible);

  // Actions from store
  const toggleRightMainPanelMode = useUiPreferencesStore(
    (s) => s.toggleRightMainPanelMode
  );
  const setRightMainPanelMode = useUiPreferencesStore(
    (s) => s.setRightMainPanelMode
  );
  const setLeftMainPanelVisible = useUiPreferencesStore(
    (s) => s.setLeftMainPanelVisible
  );
  const setLeftSidebarVisible = useUiPreferencesStore(
    (s) => s.setLeftSidebarVisible
  );

  // Memoized callbacks that include workspaceId
  const toggleRightMainPanelModeForWorkspace = useCallback(
    (mode: RightMainPanelMode) => toggleRightMainPanelMode(mode, workspaceId),
    [toggleRightMainPanelMode, workspaceId]
  );

  const setRightMainPanelModeForWorkspace = useCallback(
    (mode: RightMainPanelMode | null) =>
      setRightMainPanelMode(mode, workspaceId),
    [setRightMainPanelMode, workspaceId]
  );

  const setLeftMainPanelVisibleForWorkspace = useCallback(
    (value: boolean) => setLeftMainPanelVisible(value, workspaceId),
    [setLeftMainPanelVisible, workspaceId]
  );

  return {
    // Workspace-specific state
    rightMainPanelMode: wsState.rightMainPanelMode,
    isLeftMainPanelVisible: wsState.isLeftMainPanelVisible,

    // Global state (sidebars and terminal)
    isLeftSidebarVisible,
    isRightSidebarVisible,
    isTerminalVisible,

    // Workspace-specific actions
    toggleRightMainPanelMode: toggleRightMainPanelModeForWorkspace,
    setRightMainPanelMode: setRightMainPanelModeForWorkspace,
    setLeftMainPanelVisible: setLeftMainPanelVisibleForWorkspace,

    // Global actions
    setLeftSidebarVisible,
  };
}
