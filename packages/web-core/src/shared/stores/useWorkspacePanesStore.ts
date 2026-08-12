import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const MAX_WORKSPACE_PANES = 9;
export const DEFAULT_MAX_WORKSPACE_PANES = 4;
export const WORKSPACE_PANE_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** Panel id of the primary (route-driven) slot in the pane grid. */
export const PRIMARY_PANE_ID = 'primary';

export interface WorkspacePane {
  id: string;
  /** null → empty pane showing the workspace picker. */
  workspaceId: string | null;
  hostId: string | null;
}

interface WorkspacePanesState {
  activeUserId: string | null;
  /** Cap on total visible panes (primary + secondaries). */
  maxPanes: number;
  nextPaneId: number;
  /** Secondary panes only — the primary pane is the routed document view. */
  panes: WorkspacePane[];
  /** Active secondary pane id, or null when the primary pane is active. */
  activePaneId: string | null;
  /** Persisted split sizes keyed by panel id (PRIMARY_PANE_ID | pane id). */
  layout: Record<string, number>;
  /**
   * Bumped by keyboard pane cycling only; the grid moves DOM focus into the
   * active pane when this changes. Pointer activation must not move focus.
   */
  focusSerial: number;
  syncUser: (userId: string | null) => void;
  setMaxPanes: (maxPanes: number) => void;
  /** Set the total visible pane count (primary included). */
  setPaneCount: (total: number) => void;
  /** Show a workspace in a secondary pane (dedupe → empty → append → replace). */
  openWorkspacePane: (workspaceId: string, hostId: string | null) => void;
  setPaneWorkspace: (
    paneId: string,
    workspaceId: string,
    hostId: string | null
  ) => void;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string | null) => void;
  /** Keyboard pane cycling: activates the adjacent pane and requests focus. */
  cycleActivePane: (direction: 'next' | 'previous') => void;
  setLayout: (layout: Record<string, number>) => void;
}

export function getAdjacentWorkspacePaneId(
  panes: WorkspacePane[],
  activePaneId: string | null,
  direction: 'next' | 'previous'
): string | null {
  const order: (string | null)[] = [null, ...panes.map((pane) => pane.id)];
  const currentIndex = order.indexOf(activePaneId);
  const startIndex = currentIndex < 0 ? 0 : currentIndex;
  const offset = direction === 'next' ? 1 : -1;
  return order[(startIndex + offset + order.length) % order.length];
}

const clampPaneCount = (value: number, maxPanes: number) =>
  Math.max(1, Math.min(value, maxPanes));

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
          const panes = state.panes.slice(0, clamped - 1);
          return {
            maxPanes: clamped,
            panes,
            activePaneId: panes.some((pane) => pane.id === state.activePaneId)
              ? state.activePaneId
              : null,
          };
        }),
      setPaneCount: (total) =>
        set((state) => {
          const secondaryCount = clampPaneCount(total, state.maxPanes) - 1;
          if (secondaryCount === state.panes.length) return state;
          if (secondaryCount < state.panes.length) {
            const panes = state.panes.slice(0, secondaryCount);
            return {
              panes,
              activePaneId: panes.some((pane) => pane.id === state.activePaneId)
                ? state.activePaneId
                : null,
            };
          }
          let nextPaneId = state.nextPaneId;
          const panes = [...state.panes];
          while (panes.length < secondaryCount) {
            panes.push({
              id: `pane-${nextPaneId++}`,
              workspaceId: null,
              hostId: null,
            });
          }
          return { panes, nextPaneId };
        }),
      openWorkspacePane: (workspaceId, hostId) =>
        set((state) => {
          const existing = state.panes.find(
            (pane) => pane.workspaceId === workspaceId && pane.hostId === hostId
          );
          if (existing) {
            return { activePaneId: existing.id };
          }

          const empty = state.panes.find((pane) => pane.workspaceId === null);
          if (empty) {
            return {
              panes: state.panes.map((pane) =>
                pane.id === empty.id ? { ...pane, workspaceId, hostId } : pane
              ),
              activePaneId: empty.id,
            };
          }

          if (state.panes.length < state.maxPanes - 1) {
            const id = `pane-${state.nextPaneId}`;
            return {
              panes: [...state.panes, { id, workspaceId, hostId }],
              nextPaneId: state.nextPaneId + 1,
              activePaneId: id,
            };
          }

          if (state.panes.length === 0) return state;

          // Grid is full: replace the pane after the active one (wrapping),
          // or the first secondary when the primary is active.
          const activeIndex = state.panes.findIndex(
            (pane) => pane.id === state.activePaneId
          );
          const target =
            state.panes[(activeIndex + 1) % state.panes.length] ??
            state.panes[0];
          return {
            panes: state.panes.map((pane) =>
              pane.id === target.id ? { ...pane, workspaceId, hostId } : pane
            ),
            activePaneId: target.id,
          };
        }),
      setPaneWorkspace: (paneId, workspaceId, hostId) =>
        set((state) => ({
          panes: state.panes.map((pane) =>
            pane.id === paneId ? { ...pane, workspaceId, hostId } : pane
          ),
        })),
      closePane: (paneId) =>
        set((state) => ({
          panes: state.panes.filter((pane) => pane.id !== paneId),
          activePaneId:
            state.activePaneId === paneId ? null : state.activePaneId,
        })),
      setActivePane: (activePaneId) => set({ activePaneId }),
      cycleActivePane: (direction) =>
        set((state) => {
          if (state.panes.length === 0) return state;
          return {
            activePaneId: getAdjacentWorkspacePaneId(
              state.panes,
              state.activePaneId,
              direction
            ),
            focusSerial: state.focusSerial + 1,
          };
        }),
      setLayout: (layout) => set({ layout }),
    }),
    {
      name: 'vk-workspace-panes-v1',
      version: 1,
      partialize: ({ activeUserId, maxPanes, nextPaneId, panes, layout }) => ({
        activeUserId,
        maxPanes,
        nextPaneId,
        panes,
        layout,
      }),
    }
  )
);
