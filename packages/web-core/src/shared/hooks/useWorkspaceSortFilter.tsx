import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from 'shared/remote-types';
import type { MultiSelectDropdownOption } from '@vibe/ui/components/MultiSelectDropdown';
import { getWorkspaceActivityStatus } from '@vibe/ui/components/WorkspacesSidebar';
import { useUserContext } from '@/shared/hooks/useUserContext';
import { useAllOrganizationProjects } from '@/shared/hooks/useAllOrganizationProjects';
import { useUserOrganizations } from '@/shared/hooks/useUserOrganizations';
import type { Workspace } from '@/shared/hooks/useWorkspaces';
import { useWorkspaceHostOptions } from '@/shared/hooks/useWorkspaceHostOptions';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import {
  useUiPreferencesStore,
  type WorkspaceActivityStatus,
  type WorkspacePrFilter,
  type WorkspaceSortBy,
  type WorkspaceSortOrder,
} from '@/shared/stores/useUiPreferencesStore';

// Sentinel project id used to filter workspaces that aren't linked to any
// remote project.
export const NO_PROJECT_ID = '__no_project__';
export const LOCAL_HOST_FILTER_ID = '__local__';

const DEFAULT_WORKSPACE_SORT = {
  sortBy: 'updated_at' as WorkspaceSortBy,
  sortOrder: 'desc' as WorkspaceSortOrder,
};

function toTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function getWorkspaceSortTimestamp(
  workspace: Workspace,
  sortBy: WorkspaceSortBy
): number | null {
  if (sortBy === 'updated_at') {
    // "Last activity" = the most recent of when the latest agent turn was
    // *sent* (its process started) and when it *completed* (the response was
    // received), so sending a message bumps the workspace up the list just
    // like receiving a response does. A running turn has no completion time
    // yet, so this falls back to its start time; an idle workspace uses the
    // completion time (which is always >= its start time).
    const started = toTimestamp(workspace.latestProcessStartedAt);
    const completed = toTimestamp(workspace.latestProcessCompletedAt);
    if (started === null) return completed;
    if (completed === null) return started;
    return Math.max(started, completed);
  }

  return toTimestamp(workspace.createdAt);
}

export interface WorkspaceSortFilterModel {
  /** Options for the project multi-select (includes the "No project" entry). */
  projectOptions: MultiSelectDropdownOption<string>[];
  hostOptions: MultiSelectDropdownOption<string>[];
  /** True when a project or PR filter is active. */
  hasActiveFilters: boolean;
  /** True when sort differs from the default (updated_at desc). */
  hasNonDefaultSort: boolean;
  /** Apply project + PR + search filters, then sort (pinned first). */
  filterAndSort: (workspaces: Workspace[], searchQuery: string) => Workspace[];
  sort: {
    sortBy: WorkspaceSortBy;
    sortOrder: WorkspaceSortOrder;
    setSortBy: (sortBy: WorkspaceSortBy) => void;
    setSortOrder: (sortOrder: WorkspaceSortOrder) => void;
  };
  filter: {
    projectIds: string[];
    prFilter: WorkspacePrFilter;
    statusFilters: WorkspaceActivityStatus[];
    excludedHostIds: string[];
    setProjectFilter: (projectIds: string[]) => void;
    setPrFilter: (prFilter: WorkspacePrFilter) => void;
    setStatusFilter: (statusFilters: WorkspaceActivityStatus[]) => void;
    setHostFilter: (excludedHostIds: string[]) => void;
    clearFilters: () => void;
  };
}

/**
 * Shared workspace sort/filter model used by both the desktop sidebar
 * (WorkspacesSidebarContainer) and the remote mobile workspaces list. Owns the
 * project-filter option data (remote projects grouped by org) and the
 * filter+sort pipeline so the two surfaces stay behaviourally identical.
 */
export function useWorkspaceSortFilter(): WorkspaceSortFilterModel {
  const { t } = useTranslation('common');

  // Filter + sort state (persisted in the UI preferences store).
  const workspaceFilters = useUiPreferencesStore((s) => s.workspaceFilters);
  const setWorkspaceProjectFilter = useUiPreferencesStore(
    (s) => s.setWorkspaceProjectFilter
  );
  const setWorkspacePrFilter = useUiPreferencesStore(
    (s) => s.setWorkspacePrFilter
  );
  const setWorkspaceStatusFilter = useUiPreferencesStore(
    (s) => s.setWorkspaceStatusFilter
  );
  const setWorkspaceHostFilter = useUiPreferencesStore(
    (s) => s.setWorkspaceHostFilter
  );
  const clearWorkspaceFilters = useUiPreferencesStore(
    (s) => s.clearWorkspaceFilters
  );
  const workspaceSort = useUiPreferencesStore((s) => s.workspaceSort);
  const setWorkspaceSortBy = useUiPreferencesStore((s) => s.setWorkspaceSortBy);
  const setWorkspaceSortOrder = useUiPreferencesStore(
    (s) => s.setWorkspaceSortOrder
  );

  // Remote data for the project filter (all orgs).
  const { workspaces: remoteWorkspaces } = useUserContext();
  const { data: allRemoteProjects } = useAllOrganizationProjects();
  const { data: orgsData } = useUserOrganizations();
  const organizations = useMemo(
    () => orgsData?.organizations ?? [],
    [orgsData?.organizations]
  );
  const runtime = useAppRuntime();
  const { hosts } = useWorkspaceHostOptions();
  const hostOptions = useMemo<MultiSelectDropdownOption<string>[]>(
    () => [
      ...(runtime === 'local'
        ? [{ value: LOCAL_HOST_FILTER_ID, label: 'This machine' }]
        : []),
      ...hosts.map((host) => ({ value: host.id, label: host.name })),
    ],
    [runtime, hosts]
  );

  // Map local workspace ID → remote project ID.
  const remoteProjectByLocalId = useMemo(() => {
    const map = new Map<string, string>();
    for (const rw of remoteWorkspaces) {
      if (rw.local_workspace_id) {
        map.set(rw.local_workspace_id, rw.project_id);
      }
    }
    return map;
  }, [remoteWorkspaces]);

  const orgNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const org of organizations) {
      map.set(org.id, org.name);
    }
    return map;
  }, [organizations]);

  // Group projects by org, only including projects with linked workspaces.
  const projectGroups = useMemo(() => {
    const linkedProjectIds = new Set(remoteProjectByLocalId.values());
    const relevant = allRemoteProjects.filter((p) =>
      linkedProjectIds.has(p.id)
    );

    const groupMap = new Map<string, Project[]>();
    for (const project of relevant) {
      const arr = groupMap.get(project.organization_id) ?? [];
      arr.push(project);
      groupMap.set(project.organization_id, arr);
    }

    return Array.from(groupMap.entries())
      .map(([orgId, projects]) => ({
        orgId,
        orgName: orgNameById.get(orgId) ?? 'Unknown',
        projects: projects.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.orgName.localeCompare(b.orgName));
  }, [allRemoteProjects, remoteProjectByLocalId, orgNameById]);

  // Flat project options for MultiSelectDropdown.
  const projectOptions = useMemo<MultiSelectDropdownOption<string>[]>(
    () => [
      {
        value: NO_PROJECT_ID,
        label: t('kanban.workspaceSidebar.noProject'),
      },
      ...projectGroups.flatMap((g) =>
        g.projects.map((p) => ({
          value: p.id,
          label: p.name,
          renderOption: () => (
            <div className="flex items-center gap-base">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: `hsl(${p.color})` }}
              />
              {p.name}
            </div>
          ),
        }))
      ),
    ],
    [projectGroups, t]
  );

  const excludedHostIds = workspaceFilters.excludedHostIds ?? [];
  const hasActiveFilters =
    workspaceFilters.projectIds.length > 0 ||
    workspaceFilters.prFilter !== 'all' ||
    workspaceFilters.statusFilters.length > 0 ||
    excludedHostIds.length > 0;
  const hasNonDefaultSort =
    workspaceSort.sortBy !== DEFAULT_WORKSPACE_SORT.sortBy ||
    workspaceSort.sortOrder !== DEFAULT_WORKSPACE_SORT.sortOrder;

  const filterAndSort = useCallback(
    (workspaces: Workspace[], searchQuery: string): Workspace[] => {
      let result = workspaces;

      if (excludedHostIds.length > 0) {
        result = result.filter(
          (workspace) =>
            !excludedHostIds.includes(workspace.hostId ?? LOCAL_HOST_FILTER_ID)
        );
      }

      // Project filter
      if (workspaceFilters.projectIds.length > 0) {
        const includeNoProject =
          workspaceFilters.projectIds.includes(NO_PROJECT_ID);
        const realProjectIds = workspaceFilters.projectIds.filter(
          (id) => id !== NO_PROJECT_ID
        );
        result = result.filter((ws) => {
          const projectId = remoteProjectByLocalId.get(ws.id);
          if (!projectId) return includeNoProject;
          return realProjectIds.includes(projectId);
        });
      }

      // PR filter
      if (workspaceFilters.prFilter === 'has_pr') {
        result = result.filter((ws) => !!ws.prStatus);
      } else if (workspaceFilters.prFilter === 'no_pr') {
        result = result.filter((ws) => !ws.prStatus);
      }

      // Status filter (running / attention / idle) — same buckets as the
      // sidebar sections, via the shared getWorkspaceActivityStatus helper.
      if (workspaceFilters.statusFilters.length > 0) {
        result = result.filter((ws) =>
          workspaceFilters.statusFilters.includes(
            getWorkspaceActivityStatus(ws)
          )
        );
      }

      // Search filter (name or branch)
      const searchLower = searchQuery.toLowerCase();
      if (searchLower) {
        result = result.filter(
          (ws) =>
            ws.name.toLowerCase().includes(searchLower) ||
            ws.branch.toLowerCase().includes(searchLower)
        );
      }

      // Sort: pinned first, then by the selected timestamp (missing first).
      return [...result].sort((a, b) => {
        if (a.isPinned !== b.isPinned) {
          return a.isPinned ? -1 : 1;
        }

        const aTimestamp = getWorkspaceSortTimestamp(a, workspaceSort.sortBy);
        const bTimestamp = getWorkspaceSortTimestamp(b, workspaceSort.sortBy);

        if (aTimestamp === null && bTimestamp === null) {
          return a.name.localeCompare(b.name);
        }
        if (aTimestamp === null) {
          return -1;
        }
        if (bTimestamp === null) {
          return 1;
        }
        if (aTimestamp === bTimestamp) {
          return a.name.localeCompare(b.name);
        }

        return workspaceSort.sortOrder === 'asc'
          ? aTimestamp - bTimestamp
          : bTimestamp - aTimestamp;
      });
    },
    [
      workspaceFilters,
      excludedHostIds,
      remoteProjectByLocalId,
      workspaceSort.sortBy,
      workspaceSort.sortOrder,
    ]
  );

  return {
    projectOptions,
    hostOptions,
    hasActiveFilters,
    hasNonDefaultSort,
    filterAndSort,
    sort: {
      sortBy: workspaceSort.sortBy,
      sortOrder: workspaceSort.sortOrder,
      setSortBy: setWorkspaceSortBy,
      setSortOrder: setWorkspaceSortOrder,
    },
    filter: {
      projectIds: workspaceFilters.projectIds,
      prFilter: workspaceFilters.prFilter,
      statusFilters: workspaceFilters.statusFilters,
      excludedHostIds,
      setProjectFilter: setWorkspaceProjectFilter,
      setPrFilter: setWorkspacePrFilter,
      setStatusFilter: setWorkspaceStatusFilter,
      setHostFilter: setWorkspaceHostFilter,
      clearFilters: clearWorkspaceFilters,
    },
  };
}
