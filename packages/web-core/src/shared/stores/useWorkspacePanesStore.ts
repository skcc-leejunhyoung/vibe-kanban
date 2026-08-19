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
      | 'project-issue-workspace-create'
      | 'project-workspace-create'
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
    case 'project-issue-workspace-create':
    case 'project-workspace-create':
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
    case 'project-issue-workspace-create':
    case 'project-workspace-create':
      // One pane per project: issue/workspace sub-navigation (including
      // workspace-create) swaps content within that pane instead of spawning
      // siblings of the same board.
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
    case 'project-issue-workspace-create':
      return (
        b.kind === 'project-issue-workspace-create' &&
        a.projectId === b.projectId &&
        a.issueId === b.issueId &&
        a.draftId === b.draftId &&
        (a.hostId ?? null) === (b.hostId ?? null)
      );
    case 'project-workspace-create':
      return (
        b.kind === 'project-workspace-create' &&
        a.projectId === b.projectId &&
        a.draftId === b.draftId &&
        (a.hostId ?? null) === (b.hostId ?? null)
      );
    case 'pull-requests':
      return b.kind === 'pull-requests' && a.prUrl === b.prUrl;
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
  /** Refreshes resizable-panel registration after a reorder. */
  paneOrderVersion: number;
  /** Active pane id; null only before the first ensurePane(). */
  activePaneId: string | null;
  /** Split sizes (percent) keyed by pane id. Source of truth for the grid. */
  layout: Record<string, number>;
  /** Last pane explicitly resized by the user; every sibling stays equal. */
  resizedPaneId: string | null;
  /**
   * Bumped by keyboard pane cycling only; the grid moves DOM focus into the
   * active pane when this changes. Pointer activation must not move focus.
   */
  focusSerial: number;
  syncUser: (userId: string | null) => void;
  setMaxPanes: (maxPanes: number) => void;
  /** Make sure at least one pane exists (boot). */
  ensurePane: () => void;
  /** Split: append an empty pane at the right edge and focus it. */
  appendPane: () => void;
  /** Focus the pane at a position (0-based); no-op when absent. */
  focusPaneAt: (index: number) => void;
  /** Move DOM focus into the active pane (e.g. after clearing to the picker). */
  focusActivePane: () => void;
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
  /** Move a pane before or after another pane. */
  movePane: (paneId: string, targetPaneId: string, after: boolean) => void;
  setActivePane: (paneId: string) => void;
  /** Keyboard pane cycling: activates the adjacent pane and requests focus. */
  cycleActivePane: (direction: 'next' | 'previous') => void;
  /** Persist sizes reported by the resizable group (user drags). */
  setLayout: (layout: Record<string, number>, resizedPaneId?: string) => void;
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
// Layout math. Sizes are percentages summing ~100. A resized pane gets the
// requested width; every other pane is equal.
// ---------------------------------------------------------------------------

export function resizePaneWithEqualSiblings(
  layout: Record<string, number>,
  paneId: string,
  requestedSize: number,
  minSize: number
): Record<string, number> {
  const otherCount = Object.keys(layout).length - 1;
  if (!(paneId in layout) || otherCount < 1) return layout;
  const size = Math.max(
    minSize,
    Math.min(requestedSize, 100 - minSize * otherCount)
  );
  const otherSize = (100 - size) / otherCount;

  return Object.fromEntries(
    Object.keys(layout).map((id) => [id, id === paneId ? size : otherSize])
  );
}

/** Keep the explicitly resized pane and divide the rest equally. */
export function layoutForPanes(
  panes: WorkspacePane[],
  layout: Record<string, number>,
  resizedPaneId: string | null,
  minSize = 10
): Record<string, number> {
  const size = 100 / Math.max(panes.length, 1);
  const equalLayout = Object.fromEntries(panes.map((pane) => [pane.id, size]));
  if (!resizedPaneId || !(resizedPaneId in equalLayout)) return equalLayout;
  return resizePaneWithEqualSiblings(
    equalLayout,
    resizedPaneId,
    layout[resizedPaneId] ?? size,
    minSize
  );
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
      paneOrderVersion: 0,
      activePaneId: null,
      layout: {},
      resizedPaneId: null,
      focusSerial: 0,
      syncUser: (userId) =>
        set((state) => {
          if (state.activeUserId === userId) return state;
          return {
            activeUserId: userId,
            panes: [],
            activePaneId: null,
            layout: {},
            resizedPaneId: null,
          };
        }),
      setMaxPanes: (maxPanes) =>
        set((state) => {
          const clamped = Math.max(1, Math.min(maxPanes, MAX_WORKSPACE_PANES));
          const panes = state.panes.slice(0, Math.max(clamped, 1));
          return {
            maxPanes: clamped,
            panes,
            layout: layoutForPanes(panes, state.layout, state.resizedPaneId),
            resizedPaneId: panes.some((pane) => pane.id === state.resizedPaneId)
              ? state.resizedPaneId
              : null,
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
            resizedPaneId: null,
          };
        }),
      appendPane: () =>
        set((state) => {
          if (state.panes.length >= state.maxPanes) return state;
          if (state.panes.length === 0) {
            const id = `pane-${state.nextPaneId}`;
            return {
              panes: [{ id, destination: null }],
              nextPaneId: state.nextPaneId + 1,
              activePaneId: id,
              layout: { [id]: 100 },
              resizedPaneId: null,
              focusSerial: state.focusSerial + 1,
            };
          }
          const id = `pane-${state.nextPaneId}`;
          const panes = [...state.panes, { id, destination: null }];
          return {
            panes,
            nextPaneId: state.nextPaneId + 1,
            activePaneId: id,
            layout: layoutForPanes(panes, state.layout, state.resizedPaneId),
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
      focusActivePane: () =>
        set((state) => ({ focusSerial: state.focusSerial + 1 })),
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
              layout: layoutForPanes(panes, state.layout, state.resizedPaneId),
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
          const closedIndex = state.panes.findIndex(
            (pane) => pane.id === paneId
          );
          const panes = state.panes.filter((pane) => pane.id !== paneId);
          const resizedPaneId =
            state.resizedPaneId === paneId ? null : state.resizedPaneId;
          const layout = layoutForPanes(panes, state.layout, resizedPaneId);
          const fallbackActive =
            panes[Math.max(closedIndex - 1, 0)]?.id ?? panes[0].id;
          return {
            panes,
            layout,
            resizedPaneId,
            activePaneId:
              state.activePaneId === paneId
                ? fallbackActive
                : state.activePaneId,
          };
        }),
      movePane: (paneId, targetPaneId, after) =>
        set((state) => {
          const from = state.panes.findIndex((pane) => pane.id === paneId);
          const to = state.panes.findIndex((pane) => pane.id === targetPaneId);
          if (from < 0 || to < 0 || from === to) return state;
          const panes = [...state.panes];
          const [pane] = panes.splice(from, 1);
          const target = panes.findIndex((pane) => pane.id === targetPaneId);
          panes.splice(target + (after ? 1 : 0), 0, pane);
          return {
            panes,
            paneOrderVersion: state.paneOrderVersion + 1,
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
      setLayout: (layout, resizedPaneId) =>
        set((state) => ({
          layout: { ...state.layout, ...layout },
          resizedPaneId: resizedPaneId ?? state.resizedPaneId,
        })),
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
        resizedPaneId,
      }) => ({
        activeUserId,
        maxPanes,
        nextPaneId,
        panes,
        activePaneId,
        layout,
        resizedPaneId,
      }),
    }
  )
);
