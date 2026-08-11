import { useCallback, useEffect, useRef } from 'react';
import { useScratch } from '@/shared/hooks/useScratch';
import { useDebouncedCallback } from '@/shared/hooks/useDebouncedCallback';
import {
  ScratchType,
  type UiPreferencesData,
  type ScratchPayload,
  type WorkspacePanelStateData,
  type JsonValue,
  type PreviewShortcutData,
} from 'shared/types';
import {
  useUiPreferencesStore,
  PREVIEW_SHORTCUTS_GLOBAL_KEY,
  DEFAULT_CREATE_DRAFT_WORKSPACE_BY_DEFAULT,
  type RightMainPanelMode,
  type ContextBarPosition,
  type WorkspacePanelState,
  type WorkspaceFilterState,
  type WorkspaceSortState,
  type WorkspaceActivityStatus,
  type WorkspacePrFilter,
  type WorkspaceSortBy,
  type WorkspaceSortOrder,
  type KanbanProjectViewSelection,
  type KanbanProjectViewPreferences,
  type ProjectViewDefinition,
} from '@/shared/stores/useUiPreferencesStore';
import {
  DEFAULT_PULL_REQUEST_FILTER_STATE,
  type PullRequestFilterState,
} from '@/pages/pull-requests/pullRequestFilters';
import {
  normalizeRightSidebarSectionOrder,
  type RightSidebarSectionId,
} from '@/shared/lib/rightSidebarSections';
import type { RepoAction } from '@vibe/ui/components/RepoCard';

// Stable UUID for global UI preferences (not tied to a workspace/user)
// This is a deterministic UUID v5 generated from the namespace "ui-preferences"
// Using a fixed UUID ensures all users/sessions share the same preferences record
const UI_PREFERENCES_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Converts store state to scratch data format (camelCase to snake_case)
 */
function storeToScratchData(state: {
  repoActions: Record<string, RepoAction>;
  expanded: Record<string, boolean>;
  contextBarPosition: ContextBarPosition;
  paneSizes: Record<string, number | string>;
  collapsedPaths: Record<string, string[]>;
  fileSearchRepoId: string | null;
  isLeftSidebarVisible: boolean;
  isRightSidebarVisible: boolean;
  isTerminalVisible: boolean;
  rightSidebarSectionOrder: RightSidebarSectionId[];
  workspacePanelStates: Record<string, WorkspacePanelState>;
  workspaceFilters: WorkspaceFilterState;
  workspaceSort: WorkspaceSortState;
  selectedOrgId: string | null;
  selectedProjectId: string | null;
  createDraftWorkspaceByDefault: boolean;
  pullRequestDefaultFilters: PullRequestFilterState;
  kanbanProjectViewSelections: Record<string, KanbanProjectViewSelection>;
  projectViewsById: Record<string, ProjectViewDefinition[]>;
  kanbanProjectViewPreferences: Record<
    string,
    Record<string, KanbanProjectViewPreferences>
  >;
  collapsedGroupsByProject: Record<string, string[]>;
  previewShortcutsByProject: Record<string, PreviewShortcutData[]>;
}): UiPreferencesData {
  const workspacePanelStates: { [key: string]: WorkspacePanelStateData } = {};
  for (const [key, value] of Object.entries(state.workspacePanelStates)) {
    workspacePanelStates[key] = {
      right_main_panel_mode: value.rightMainPanelMode,
      is_left_main_panel_visible: value.isLeftMainPanelVisible,
    };
  }

  return {
    repo_actions: state.repoActions as { [key: string]: string },
    expanded: state.expanded,
    context_bar_position: state.contextBarPosition,
    pane_sizes: state.paneSizes as { [key: string]: JsonValue },
    collapsed_paths: state.collapsedPaths,
    file_search_repo_id: state.fileSearchRepoId,
    is_left_sidebar_visible: state.isLeftSidebarVisible,
    is_right_sidebar_visible: state.isRightSidebarVisible,
    is_terminal_visible: state.isTerminalVisible,
    right_sidebar_section_order: state.rightSidebarSectionOrder,
    workspace_panel_states: workspacePanelStates,
    workspace_filters: {
      project_ids: state.workspaceFilters.projectIds,
      pr_filter: state.workspaceFilters.prFilter,
      status_filters: state.workspaceFilters.statusFilters,
      excluded_host_ids: state.workspaceFilters.excludedHostIds,
    },
    workspace_sort: {
      sort_by: state.workspaceSort.sortBy,
      sort_order: state.workspaceSort.sortOrder,
    },
    selected_org_id: state.selectedOrgId,
    selected_project_id: state.selectedProjectId,
    create_draft_workspace_by_default: state.createDraftWorkspaceByDefault,
    pull_request_default_filters:
      state.pullRequestDefaultFilters as unknown as JsonValue,
    kanban_project_view_selections: state.kanbanProjectViewSelections as Record<
      string,
      JsonValue
    >,
    // Transient per-view toolbar overrides layered over each view's configured
    // default. Persisted so ad-hoc filtering survives reloads; "Clear filters"
    // removes the entry to reveal the view default again.
    kanban_project_view_preferences:
      state.kanbanProjectViewPreferences as Record<string, JsonValue>,
    kanban_project_views: state.projectViewsById as unknown as Record<
      string,
      JsonValue
    >,
    kanban_collapsed_groups:
      state.collapsedGroupsByProject as unknown as Record<string, JsonValue>,
    // Legacy global list is migrated into the per-project map on read, so we
    // always persist it empty going forward.
    preview_shortcuts: [],
    preview_shortcuts_by_project: state.previewShortcutsByProject,
  };
}

/**
 * Normalizes the saved PR default filters, migrating the legacy single
 * `repository` string into the multi-select `repositories` array so defaults
 * saved before multi-repo support still apply on load.
 */
function migratePullRequestDefaultFilters(
  saved: unknown
): PullRequestFilterState {
  const legacy = (saved ?? {}) as Partial<PullRequestFilterState> & {
    repository?: string;
  };
  const merged: PullRequestFilterState & { repository?: string } = {
    ...DEFAULT_PULL_REQUEST_FILTER_STATE,
    ...legacy,
  };
  if (
    merged.repositories.length === 0 &&
    legacy.repository &&
    legacy.repository !== 'all'
  ) {
    merged.repositories = [legacy.repository];
  }
  delete merged.repository;
  return merged;
}

/**
 * Converts scratch data to store state format (snake_case to camelCase)
 */
function scratchDataToStore(data: UiPreferencesData): {
  repoActions: Record<string, RepoAction>;
  expanded: Record<string, boolean>;
  contextBarPosition: ContextBarPosition;
  paneSizes: Record<string, number | string>;
  collapsedPaths: Record<string, string[]>;
  fileSearchRepoId: string | null;
  isLeftSidebarVisible: boolean;
  isRightSidebarVisible: boolean;
  isTerminalVisible: boolean;
  rightSidebarSectionOrder: RightSidebarSectionId[];
  workspacePanelStates: Record<string, WorkspacePanelState>;
  workspaceFilters: WorkspaceFilterState;
  workspaceSort: WorkspaceSortState;
  selectedOrgId: string | null;
  selectedProjectId: string | null;
  createDraftWorkspaceByDefault: boolean;
  pullRequestDefaultFilters: PullRequestFilterState;
  kanbanProjectViewSelections: Record<string, KanbanProjectViewSelection>;
  projectViewsById: Record<string, ProjectViewDefinition[]>;
  kanbanProjectViewPreferences: Record<
    string,
    Record<string, KanbanProjectViewPreferences>
  >;
  collapsedGroupsByProject: Record<string, string[]>;
  previewShortcutsByProject: Record<string, PreviewShortcutData[]>;
} {
  const workspacePanelStates: Record<string, WorkspacePanelState> = {};
  if (data.workspace_panel_states) {
    for (const [key, value] of Object.entries(data.workspace_panel_states)) {
      if (value) {
        workspacePanelStates[key] = {
          rightMainPanelMode:
            (value.right_main_panel_mode as RightMainPanelMode) ?? null,
          isLeftMainPanelVisible: value.is_left_main_panel_visible ?? true,
        };
      }
    }
  }

  // Backwards compatibility with older payloads that used
  // file_search_repo_by_project (project_id -> repo_id).
  const legacyFileSearchRepoByProject = (
    data as UiPreferencesData & {
      file_search_repo_by_project?: Record<string, string>;
    }
  ).file_search_repo_by_project;
  const legacyFileSearchRepoId =
    legacyFileSearchRepoByProject &&
    Object.values(legacyFileSearchRepoByProject)[0]
      ? Object.values(legacyFileSearchRepoByProject)[0]
      : null;

  // Migrate legacy global preview shortcuts into the per-project map under the
  // global bucket (merge by url so we don't duplicate already-migrated entries).
  const previewShortcutsByProject: Record<string, PreviewShortcutData[]> = {
    ...((data.preview_shortcuts_by_project ?? {}) as Record<
      string,
      PreviewShortcutData[]
    >),
  };
  const legacyGlobalShortcuts = data.preview_shortcuts ?? [];
  if (legacyGlobalShortcuts.length > 0) {
    const globalBucket =
      previewShortcutsByProject[PREVIEW_SHORTCUTS_GLOBAL_KEY] ?? [];
    const byUrl = new Map(
      globalBucket.map((shortcut) => [shortcut.url, shortcut])
    );
    for (const shortcut of legacyGlobalShortcuts) {
      if (!byUrl.has(shortcut.url)) {
        byUrl.set(shortcut.url, shortcut);
      }
    }
    previewShortcutsByProject[PREVIEW_SHORTCUTS_GLOBAL_KEY] = Array.from(
      byUrl.values()
    );
  }

  return {
    repoActions: (data.repo_actions ?? {}) as Record<string, RepoAction>,
    expanded: (data.expanded ?? {}) as Record<string, boolean>,
    contextBarPosition:
      (data.context_bar_position as ContextBarPosition) ?? 'middle-right',
    paneSizes: (data.pane_sizes ?? {}) as Record<string, number | string>,
    collapsedPaths: (data.collapsed_paths ?? {}) as Record<string, string[]>,
    fileSearchRepoId: data.file_search_repo_id ?? legacyFileSearchRepoId,
    isLeftSidebarVisible: data.is_left_sidebar_visible ?? true,
    isRightSidebarVisible: data.is_right_sidebar_visible ?? true,
    isTerminalVisible: data.is_terminal_visible ?? true,
    rightSidebarSectionOrder: normalizeRightSidebarSectionOrder(
      data.right_sidebar_section_order
    ),
    workspacePanelStates,
    workspaceFilters: {
      projectIds: data.workspace_filters?.project_ids ?? [],
      prFilter:
        (data.workspace_filters?.pr_filter as WorkspacePrFilter) ?? 'all',
      statusFilters:
        (data.workspace_filters?.status_filters as WorkspaceActivityStatus[]) ??
        [],
      excludedHostIds: data.workspace_filters?.excluded_host_ids ?? [],
    },
    workspaceSort: {
      sortBy: (data.workspace_sort?.sort_by as WorkspaceSortBy) ?? 'updated_at',
      sortOrder:
        (data.workspace_sort?.sort_order as WorkspaceSortOrder) ?? 'desc',
    },
    selectedOrgId: data.selected_org_id ?? null,
    selectedProjectId: data.selected_project_id ?? null,
    createDraftWorkspaceByDefault:
      data.create_draft_workspace_by_default ??
      DEFAULT_CREATE_DRAFT_WORKSPACE_BY_DEFAULT,
    pullRequestDefaultFilters: migratePullRequestDefaultFilters(
      data.pull_request_default_filters
    ),
    kanbanProjectViewSelections: (data.kanban_project_view_selections ??
      {}) as Record<string, KanbanProjectViewSelection>,
    projectViewsById: (data.kanban_project_views ?? {}) as unknown as Record<
      string,
      ProjectViewDefinition[]
    >,
    kanbanProjectViewPreferences: (data.kanban_project_view_preferences ??
      {}) as unknown as Record<
      string,
      Record<string, KanbanProjectViewPreferences>
    >,
    collapsedGroupsByProject: (data.kanban_collapsed_groups ??
      {}) as unknown as Record<string, string[]>,
    previewShortcutsByProject,
  };
}

/**
 * Hook that syncs UI preferences between Zustand store and server scratch storage.
 * Should be used once at the app root level.
 */
export function useUiPreferencesScratch() {
  const { scratch, updateScratch, isLoading, isConnected } = useScratch(
    ScratchType.UI_PREFERENCES,
    UI_PREFERENCES_ID
  );

  // Track whether we've initialized from server
  const hasInitializedRef = useRef(false);
  // Track whether we're currently applying server data to prevent save loops
  const isApplyingServerDataRef = useRef(false);

  // Get current store state
  const storeState = useUiPreferencesStore((state) => ({
    repoActions: state.repoActions,
    expanded: state.expanded,
    contextBarPosition: state.contextBarPosition,
    paneSizes: state.paneSizes,
    collapsedPaths: state.collapsedPaths,
    fileSearchRepoId: state.fileSearchRepoId,
    isLeftSidebarVisible: state.isLeftSidebarVisible,
    isRightSidebarVisible: state.isRightSidebarVisible,
    isTerminalVisible: state.isTerminalVisible,
    rightSidebarSectionOrder: state.rightSidebarSectionOrder,
    workspacePanelStates: state.workspacePanelStates,
    workspaceFilters: state.workspaceFilters,
    workspaceSort: state.workspaceSort,
    selectedOrgId: state.selectedOrgId,
    selectedProjectId: state.selectedProjectId,
    createDraftWorkspaceByDefault: state.createDraftWorkspaceByDefault,
    pullRequestDefaultFilters: state.pullRequestDefaultFilters,
    kanbanProjectViewSelections: state.kanbanProjectViewSelections,
    projectViewsById: state.projectViewsById,
    kanbanProjectViewPreferences: state.kanbanProjectViewPreferences,
    collapsedGroupsByProject: state.collapsedGroupsByProject,
    previewShortcutsByProject: state.previewShortcutsByProject,
  }));

  // Extract scratch data
  const payload = scratch?.payload as ScratchPayload | undefined;
  const scratchData: UiPreferencesData | undefined =
    payload?.type === 'UI_PREFERENCES' ? payload.data : undefined;

  // Save to server function
  const saveToServer = useCallback(async () => {
    if (isApplyingServerDataRef.current || !hasInitializedRef.current) {
      return;
    }

    const currentState = useUiPreferencesStore.getState();
    const data = storeToScratchData({
      repoActions: currentState.repoActions,
      expanded: currentState.expanded,
      contextBarPosition: currentState.contextBarPosition,
      paneSizes: currentState.paneSizes,
      collapsedPaths: currentState.collapsedPaths,
      fileSearchRepoId: currentState.fileSearchRepoId,
      isLeftSidebarVisible: currentState.isLeftSidebarVisible,
      isRightSidebarVisible: currentState.isRightSidebarVisible,
      isTerminalVisible: currentState.isTerminalVisible,
      rightSidebarSectionOrder: currentState.rightSidebarSectionOrder,
      workspacePanelStates: currentState.workspacePanelStates,
      workspaceFilters: currentState.workspaceFilters,
      workspaceSort: currentState.workspaceSort,
      selectedOrgId: currentState.selectedOrgId,
      selectedProjectId: currentState.selectedProjectId,
      createDraftWorkspaceByDefault: currentState.createDraftWorkspaceByDefault,
      pullRequestDefaultFilters: currentState.pullRequestDefaultFilters,
      kanbanProjectViewSelections: currentState.kanbanProjectViewSelections,
      projectViewsById: currentState.projectViewsById,
      kanbanProjectViewPreferences: currentState.kanbanProjectViewPreferences,
      collapsedGroupsByProject: currentState.collapsedGroupsByProject,
      previewShortcutsByProject: currentState.previewShortcutsByProject,
    });

    try {
      await updateScratch({
        payload: {
          type: 'UI_PREFERENCES',
          data,
        },
      });
    } catch (e) {
      console.error('[useUiPreferencesScratch] Failed to save:', e);
    }
  }, [updateScratch]);

  const { debounced: debouncedSave } = useDebouncedCallback(saveToServer, 500);

  // Initialize store from server data when first loaded
  useEffect(() => {
    if (hasInitializedRef.current || isLoading || !isConnected) {
      return;
    }

    hasInitializedRef.current = true;

    if (scratchData) {
      // Server has data - apply it to store
      isApplyingServerDataRef.current = true;
      const serverState = scratchDataToStore(scratchData);

      // Merge server state into the store
      useUiPreferencesStore.setState({
        repoActions: serverState.repoActions,
        expanded: serverState.expanded,
        contextBarPosition: serverState.contextBarPosition,
        paneSizes: serverState.paneSizes,
        collapsedPaths: serverState.collapsedPaths,
        fileSearchRepoId: serverState.fileSearchRepoId,
        isLeftSidebarVisible: serverState.isLeftSidebarVisible,
        isRightSidebarVisible: serverState.isRightSidebarVisible,
        isTerminalVisible: serverState.isTerminalVisible,
        rightSidebarSectionOrder: serverState.rightSidebarSectionOrder,
        workspacePanelStates: serverState.workspacePanelStates,
        workspaceFilters: serverState.workspaceFilters,
        workspaceSort: serverState.workspaceSort,
        selectedOrgId: serverState.selectedOrgId,
        selectedProjectId: serverState.selectedProjectId,
        createDraftWorkspaceByDefault:
          serverState.createDraftWorkspaceByDefault,
        pullRequestDefaultFilters: serverState.pullRequestDefaultFilters,
        kanbanProjectViewSelections: serverState.kanbanProjectViewSelections,
        projectViewsById: serverState.projectViewsById,
        kanbanProjectViewPreferences: serverState.kanbanProjectViewPreferences,
        collapsedGroupsByProject: serverState.collapsedGroupsByProject,
        previewShortcutsByProject: serverState.previewShortcutsByProject,
      });

      // Allow a brief delay for state to settle
      setTimeout(() => {
        isApplyingServerDataRef.current = false;
      }, 100);
    }
  }, [isLoading, isConnected, scratchData]);

  // Subscribe to store changes and save to server
  useEffect(() => {
    const unsubscribe = useUiPreferencesStore.subscribe(() => {
      if (!isApplyingServerDataRef.current && hasInitializedRef.current) {
        debouncedSave();
      }
    });

    return unsubscribe;
  }, [debouncedSave]);

  return {
    isLoading,
    isConnected,
    // Expose for debugging
    scratchData,
    storeState,
  };
}
