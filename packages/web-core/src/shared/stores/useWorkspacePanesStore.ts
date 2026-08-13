import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppDestination } from '@/shared/lib/routes/appNavigation';

export const MAX_WORKSPACE_PANES = 9;
export const DEFAULT_MAX_WORKSPACE_PANES = 4;
export const WORKSPACE_PANE_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** Destinations a pane can render in-document. */
export type WorkspacePaneDestination = Extract<
  AppDestination,
  {
    kind:
      | 'workspace'
      | 'project'
      | 'project-issue'
      | 'project-issue-workspace'
      | 'pull-requests'
      | 'notifications';
  }
>;

export function isPaneRenderableDestination(
  destination: AppDestination | null
): destination is WorkspacePaneDestination {
  switch (destination?.kind) {
    case 'workspace':
    case 'project':
    case 'project-issue':
    case 'project-issue-workspace':
    case 'pull-requests':
    case 'notifications':
      return true;
    default:
      return false;
  }
}

/**
 * Routes that show the pane grid on desktop local: every pane-renderable
 * destination plus the bare workspaces list (grid with whatever panes exist).
 */
export function isPaneGridDestination(
  destination: AppDestination | null
): boolean {
  return (
    isPaneRenderableDestination(destination) ||
    destination?.kind === 'workspaces'
  );
}

/** Identity key used to dedupe panes showing the same destination. */
export function paneDestinationKey(
  destination: WorkspacePaneDestination
): string {
  switch (destination.kind) {
    case 'workspace':
      return `workspace:${destination.hostId ?? ''}:${destination.workspaceId}`;
    case 'project':
    case 'project-issue':
    case 'project-issue-workspace':
      // One pane per project: issue/workspace sub-navigation swaps content
      // within that pane instead of spawning siblings of the same board.
      return `project:${destination.projectId}`;
    case 'pull-requests':
      return 'pull-requests';
    case 'notifications':
      return 'notifications';
  }
}

/** Structural equality for pane destinations (hostId null/undefined folded). */
export function sameDestination(
  a: WorkspacePaneDestination | null,
  b: WorkspacePaneDestination | null
): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'workspace':
      return (
        b.kind === 'workspace' &&
        a.workspaceId === b.workspaceId &&
        (a.hostId ?? null) === (b.hostId ?? null)
      );
    case 'project':
      return b.kind === 'project' && a.projectId === b.projectId;
    case 'project-issue':
      return (
        b.kind === 'project-issue' &&
        a.projectId === b.projectId &&
        a.issueId === b.issueId
      );
    case 'project-issue-workspace':
      return (
        b.kind === 'project-issue-workspace' &&
        a.projectId === b.projectId &&
        a.issueId === b.issueId &&
        a.workspaceId === b.workspaceId &&
        (a.hostId ?? null) === (b.hostId ?? null)
      );
    case 'pull-requests':
    case 'notifications':
      return true;
  }
}

export interface WorkspacePane {
  id: string;
  /** null → empty pane showing the workspace picker. */
  destination: WorkspacePaneDestination | null;
}

interface WorkspacePanesState {
  activeUserId: string | null;
  /** Cap on total visible panes. */
  maxPanes: number;
  nextPaneId: number;
  /** Every visible pane, left to right. All panes are equals. */
  panes: WorkspacePane[];
  /** Active pane id; null only before the first ensurePane(). */
  activePaneId: string | null;
  /** Split sizes (percent) keyed by pane id. Source of truth for the grid. */
  layout: Record<string, number>;
  /**
   * Bumped by keyboard pane cycling only; the grid moves DOM focus into the
   * active pane when this changes. Pointer activation must not move focus.
   */
  focusSerial: number;
  syncUser: (userId: string | null) => void;
  setMaxPanes: (maxPanes: number) => void;
  /** Make sure at least one pane exists (boot). */
  ensurePane: () => void;
  /** Split: insert an empty pane right of the active one and focus it. */
  insertPaneAfterActive: () => void;
  /** Focus the pane at a position (0-based); no-op when absent. */
  focusPaneAt: (index: number) => void;
  /** Show a destination in some pane (dedupe → empty → split → replace). */
  openPaneForDestination: (destination: WorkspacePaneDestination) => void;
  /**
   * Adopt an externally navigated destination (deep link, notification):
   * activate the pane already showing it, else replace the active pane's
   * content — external navigation never changes the split structure.
   */
  adoptRouteDestination: (destination: WorkspacePaneDestination) => void;
  setPaneDestination: (
    paneId: string,
    destination: WorkspacePaneDestination
  ) => void;
  clearPaneDestination: (paneId: string) => void;
  /** Close a pane; the last pane is cleared instead of removed. */
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  /** Keyboard pane cycling: activates the adjacent pane and requests focus. */
  cycleActivePane: (direction: 'next' | 'previous') => void;
  /** Persist sizes reported by the resizable group (user drags). */
  setLayout: (layout: Record<string, number>) => void;
}

export function getAdjacentWorkspacePaneId(
  panes: WorkspacePane[],
  activePaneId: string | null,
  direction: 'next' | 'previous'
): string | null {
  if (panes.length === 0) return null;
  const currentIndex = panes.findIndex((pane) => pane.id === activePaneId);
  const startIndex = currentIndex < 0 ? 0 : currentIndex;
  const offset = direction === 'next' ? 1 : -1;
  return panes[(startIndex + offset + panes.length) % panes.length].id;
}

/**
 * The workspace shown by the active pane, or null when it shows non-workspace
 * content. Document chrome (navbar toggles, sidebar clicks) targets this.
 */
export function getActivePaneWorkspace(
  state: Pick<WorkspacePanesState, 'panes' | 'activePaneId'>
): { workspaceId: string; hostId: string | null } | null {
  const destination = state.panes.find(
    (pane) => pane.id === state.activePaneId
  )?.destination;
  if (destination?.kind !== 'workspace') return null;
  return {
    workspaceId: destination.workspaceId,
    hostId: destination.hostId ?? null,
  };
}

export function useActivePaneWorkspace(): {
  workspaceId: string;
  hostId: string | null;
} | null {
  const activePaneId = useWorkspacePanesStore((s) => s.activePaneId);
  const panes = useWorkspacePanesStore((s) => s.panes);
  return getActivePaneWorkspace({ panes, activePaneId });
}

// ---------------------------------------------------------------------------
// Layout math — VS Code split semantics. Sizes are percentages summing ~100.
// Structural changes compute an explicit layout so untouched panes keep their
// width; only user drags overwrite these via setLayout.
// ---------------------------------------------------------------------------

function normalizedLayout(
  panes: WorkspacePane[],
  layout: Record<string, number>
): Record<string, number> {
  const fallback = 100 / Math.max(panes.length, 1);
  const sizes = panes.map((pane) => layout[pane.id] ?? fallback);
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
  return Object.fromEntries(
    panes.map((pane, index) => [pane.id, (sizes[index] / total) * 100])
  );
}

/** Existing pane ratios stay intact while all make equal room for the new pane. */
export function layoutAfterSplit(
  panes: WorkspacePane[],
  layout: Record<string, number>,
  newPaneId: string
): Record<string, number> {
  const existing = panes.filter((pane) => pane.id !== newPaneId);
  const base = normalizedLayout(existing, layout);
  const newSize = 100 / panes.length;
  const scale = (100 - newSize) / 100;
  return {
    ...Object.fromEntries(
      Object.entries(base).map(([id, size]) => [id, size * scale])
    ),
    [newPaneId]: newSize,
  };
}

/** Remaining panes preserve their ratios while expanding into the closed space. */
export function layoutAfterClose(
  panes: WorkspacePane[],
  layout: Record<string, number>,
  closedPaneId: string
): Record<string, number> {
  const base = normalizedLayout(panes, layout);
  if (!panes.some((pane) => pane.id === closedPaneId)) return base;
  const remaining = panes.filter((pane) => pane.id !== closedPaneId);
  return normalizedLayout(remaining, base);
}

interface PersistedPaneV1 {
  id: string;
  workspaceId: string | null;
  hostId: string | null;
}

export const useWorkspacePanesStore = create<WorkspacePanesState>()(
  persist(
    (set) => ({
      activeUserId: null,
      maxPanes: DEFAULT_MAX_WORKSPACE_PANES,
      nextPaneId: 1,
      panes: [],
      activePaneId: null,
      layout: {},
      focusSerial: 0,
      syncUser: (userId) =>
        set((state) => {
          if (state.activeUserId === userId) return state;
          return {
            activeUserId: userId,
            panes: [],
            activePaneId: null,
            layout: {},
          };
        }),
      setMaxPanes: (maxPanes) =>
        set((state) => {
          const clamped = Math.max(1, Math.min(maxPanes, MAX_WORKSPACE_PANES));
          const panes = state.panes.slice(0, Math.max(clamped, 1));
          return {
            maxPanes: clamped,
            panes,
            layout: normalizedLayout(panes, state.layout),
            activePaneId: panes.some((pane) => pane.id === state.activePaneId)
              ? state.activePaneId
              : (panes[0]?.id ?? null),
          };
        }),
      ensurePane: () =>
        set((state) => {
          if (state.panes.length > 0) {
            // Repair a missing or stale (persisted) active pane id.
            if (!state.panes.some((pane) => pane.id === state.activePaneId)) {
              return { activePaneId: state.panes[0].id };
            }
            return state;
          }
          const id = `pane-${state.nextPaneId}`;
          return {
            panes: [{ id, destination: null }],
            nextPaneId: state.nextPaneId + 1,
            activePaneId: id,
            layout: { [id]: 100 },
          };
        }),
      insertPaneAfterActive: () =>
        set((state) => {
          if (state.panes.length >= state.maxPanes) return state;
          if (state.panes.length === 0) {
            const id = `pane-${state.nextPaneId}`;
            return {
              panes: [{ id, destination: null }],
              nextPaneId: state.nextPaneId + 1,
              activePaneId: id,
              layout: { [id]: 100 },
              focusSerial: state.focusSerial + 1,
            };
          }
          const activeIndex = state.panes.findIndex(
            (pane) => pane.id === state.activePaneId
          );
          const insertAt =
            activeIndex >= 0 ? activeIndex + 1 : state.panes.length;
          const id = `pane-${state.nextPaneId}`;
          const panes = [
            ...state.panes.slice(0, insertAt),
            { id, destination: null },
            ...state.panes.slice(insertAt),
          ];
          return {
            panes,
            nextPaneId: state.nextPaneId + 1,
            activePaneId: id,
            layout: layoutAfterSplit(panes, state.layout, id),
            focusSerial: state.focusSerial + 1,
          };
        }),
      focusPaneAt: (index) =>
        set((state) => {
          const pane = state.panes[index];
          if (!pane) return state;
          return {
            activePaneId: pane.id,
            focusSerial: state.focusSerial + 1,
          };
        }),
      openPaneForDestination: (destination) =>
        set((state) => {
          const key = paneDestinationKey(destination);
          const existing = state.panes.find(
            (pane) =>
              pane.destination !== null &&
              paneDestinationKey(pane.destination) === key
          );
          if (existing) {
            // Same identity (e.g. the pane's project) — adopt the more
            // specific destination (issue/workspace sub-navigation) too.
            return {
              panes: state.panes.map((pane) =>
                pane.id === existing.id ? { ...pane, destination } : pane
              ),
              activePaneId: existing.id,
            };
          }

          const empty = state.panes.find((pane) => pane.destination === null);
          if (empty) {
            return {
              panes: state.panes.map((pane) =>
                pane.id === empty.id ? { ...pane, destination } : pane
              ),
              activePaneId: empty.id,
            };
          }

          if (state.panes.length < state.maxPanes) {
            const id = `pane-${state.nextPaneId}`;
            const panes = [...state.panes, { id, destination }];
            return {
              panes,
              nextPaneId: state.nextPaneId + 1,
              activePaneId: id,
              layout: layoutAfterSplit(panes, state.layout, id),
            };
          }

          if (state.panes.length === 0) return state;

          // Grid is full: replace the pane after the active one (wrapping).
          const activeIndex = state.panes.findIndex(
            (pane) => pane.id === state.activePaneId
          );
          const target =
            state.panes[(activeIndex + 1) % state.panes.length] ??
            state.panes[0];
          return {
            panes: state.panes.map((pane) =>
              pane.id === target.id ? { ...pane, destination } : pane
            ),
            activePaneId: target.id,
          };
        }),
      adoptRouteDestination: (destination) =>
        set((state) => {
          const key = paneDestinationKey(destination);
          const existing = state.panes.find(
            (pane) =>
              pane.destination !== null &&
              paneDestinationKey(pane.destination) === key
          );
          if (existing) {
            if (sameDestination(existing.destination, destination)) {
              return state.activePaneId === existing.id
                ? state
                : { activePaneId: existing.id };
            }
            return {
              panes: state.panes.map((pane) =>
                pane.id === existing.id ? { ...pane, destination } : pane
              ),
              activePaneId: existing.id,
            };
          }
          const activeId = state.panes.some(
            (pane) => pane.id === state.activePaneId
          )
            ? state.activePaneId!
            : state.panes[0]?.id;
          if (!activeId) return state;
          return {
            panes: state.panes.map((pane) =>
              pane.id === activeId ? { ...pane, destination } : pane
            ),
            activePaneId: activeId,
          };
        }),
      setPaneDestination: (paneId, destination) =>
        set((state) => ({
          panes: state.panes.map((pane) =>
            pane.id === paneId ? { ...pane, destination } : pane
          ),
        })),
      clearPaneDestination: (paneId) =>
        set((state) => ({
          panes: state.panes.map((pane) =>
            pane.id === paneId ? { ...pane, destination: null } : pane
          ),
        })),
      closePane: (paneId) =>
        set((state) => {
          if (state.panes.length <= 1) {
            // Never drop the last pane — clear it back to the picker.
            return {
              panes: state.panes.map((pane) =>
                pane.id === paneId ? { ...pane, destination: null } : pane
              ),
            };
          }
          const layout = layoutAfterClose(state.panes, state.layout, paneId);
          const closedIndex = state.panes.findIndex(
            (pane) => pane.id === paneId
          );
          const panes = state.panes.filter((pane) => pane.id !== paneId);
          const fallbackActive =
            panes[Math.max(closedIndex - 1, 0)]?.id ?? panes[0].id;
          return {
            panes,
            layout,
            activePaneId:
              state.activePaneId === paneId
                ? fallbackActive
                : state.activePaneId,
          };
        }),
      setActivePane: (activePaneId) => set({ activePaneId }),
      cycleActivePane: (direction) =>
        set((state) => {
          if (state.panes.length < 2) return state;
          return {
            activePaneId: getAdjacentWorkspacePaneId(
              state.panes,
              state.activePaneId,
              direction
            ),
            focusSerial: state.focusSerial + 1,
          };
        }),
      setLayout: (layout) =>
        set((state) => ({ layout: { ...state.layout, ...layout } })),
    }),
    {
      name: 'vk-workspace-panes-v1',
      version: 3,
      migrate: (persisted, version) => {
        const state = persisted as Partial<WorkspacePanesState> & {
          panes?: unknown[];
        };
        let panes: WorkspacePane[];
        if (version >= 2) {
          panes = (state.panes ?? []) as WorkspacePane[];
        } else {
          // v1 panes carried {workspaceId, hostId} instead of a destination.
          panes = (state.panes ?? []).map((raw) => {
            const pane = raw as unknown as PersistedPaneV1;
            return {
              id: pane.id,
              destination: pane.workspaceId
                ? {
                    kind: 'workspace' as const,
                    workspaceId: pane.workspaceId,
                    hostId: pane.hostId,
                  }
                : null,
            };
          });
        }
        if (version < 3) {
          // v2 panes were secondaries next to a route-driven primary. Prepend
          // an empty pane in its place; the route seeds it on first mount.
          const nextPaneId = state.nextPaneId ?? panes.length + 1;
          const first: WorkspacePane = {
            id: `pane-${nextPaneId}`,
            destination: null,
          };
          panes = [first, ...panes];
          return {
            ...state,
            panes,
            nextPaneId: nextPaneId + 1,
            activePaneId: first.id,
          } as WorkspacePanesState;
        }
        return { ...state, panes } as WorkspacePanesState;
      },
      partialize: ({
        activeUserId,
        maxPanes,
        nextPaneId,
        panes,
        activePaneId,
        layout,
      }) => ({
        activeUserId,
        maxPanes,
        nextPaneId,
        panes,
        activePaneId,
        layout,
      }),
    }
  )
);
