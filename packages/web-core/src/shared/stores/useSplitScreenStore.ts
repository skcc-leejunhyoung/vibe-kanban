import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SplitPreset = 1 | 2 | 3 | 4;

export function shouldRenderSplitScreenFrames(preset: SplitPreset): boolean {
  return preset > 1;
}

export interface SplitPaneState {
  id: string;
  url: string | null;
}

export interface SplitPresetState {
  panes: SplitPaneState[];
  activePaneId: string;
  horizontalSizes?: number[];
  verticalSizes?: number[];
}

export function getSplitScreenUserId({
  isLoaded,
  isSignedIn,
  userId,
}: {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
}): string | null | undefined {
  if (!isLoaded) return undefined;
  return isSignedIn ? userId : null;
}

export function getAdjacentSplitPaneId(
  panes: SplitPaneState[],
  currentPaneId: string,
  direction: 'next' | 'previous'
): string | null {
  if (panes.length === 0) return null;
  const currentIndex = panes.findIndex((pane) => pane.id === currentPaneId);
  const startIndex = currentIndex < 0 ? 0 : currentIndex;
  const offset = direction === 'next' ? 1 : -1;
  const nextIndex = (startIndex + offset + panes.length) % panes.length;
  return panes[nextIndex]?.id ?? null;
}

type PresetStates = Record<SplitPreset, SplitPresetState>;

interface SplitScreenState {
  activeUserId: string | null;
  preset: SplitPreset;
  presets: PresetStates;
  syncUser: (userId: string | null) => void;
  setPreset: (preset: SplitPreset, currentUrl: string) => void;
  setActivePane: (paneId: string) => void;
  setPaneUrl: (paneId: string, url: string) => void;
  movePane: (sourceId: string, targetId: string) => void;
  setHorizontalSizes: (sizes: number[], offset?: number) => void;
  setVerticalSizes: (sizes: number[]) => void;
}

const paneCount = (preset: SplitPreset) => preset;

const makePreset = (preset: SplitPreset): SplitPresetState => ({
  panes: Array.from({ length: paneCount(preset) }, (_, index) => ({
    id: `preset-${preset}-pane-${index + 1}`,
    url: null,
  })),
  activePaneId: `preset-${preset}-pane-1`,
});

const initialPresets = (): PresetStates => ({
  1: makePreset(1),
  2: makePreset(2),
  3: makePreset(3),
  4: makePreset(4),
});

function updateCurrentPreset(
  state: SplitScreenState,
  update: (preset: SplitPresetState) => SplitPresetState
) {
  return {
    presets: {
      ...state.presets,
      [state.preset]: update(state.presets[state.preset]),
    },
  };
}

export const useSplitScreenStore = create<SplitScreenState>()(
  persist(
    (set) => ({
      activeUserId: null,
      preset: 1,
      presets: initialPresets(),
      syncUser: (userId) =>
        set((state) => {
          if (state.activeUserId === userId) return state;
          return {
            activeUserId: userId,
            preset: 1,
            presets: initialPresets(),
          };
        }),
      setPreset: (preset, currentUrl) =>
        set((state) => {
          const destination = state.presets[preset];
          const source = state.presets[state.preset];
          const activeSourceUrl =
            source.panes.find((pane) => pane.id === source.activePaneId)?.url ??
            currentUrl;
          const hasSavedPage = destination.panes.some((pane) => pane.url);

          return {
            preset,
            presets: {
              ...state.presets,
              [preset]: hasSavedPage
                ? destination
                : {
                    ...destination,
                    panes: destination.panes.map((pane, index) => ({
                      ...pane,
                      url: index === 0 ? activeSourceUrl : currentUrl,
                    })),
                  },
            },
          };
        }),
      setActivePane: (paneId) =>
        set((state) =>
          updateCurrentPreset(state, (preset) => ({
            ...preset,
            activePaneId: paneId,
          }))
        ),
      setPaneUrl: (paneId, url) =>
        set((state) =>
          updateCurrentPreset(state, (preset) => ({
            ...preset,
            panes: preset.panes.map((pane) =>
              pane.id === paneId ? { ...pane, url } : pane
            ),
          }))
        ),
      movePane: (sourceId, targetId) =>
        set((state) =>
          updateCurrentPreset(state, (preset) => {
            const sourceIndex = preset.panes.findIndex(
              (pane) => pane.id === sourceId
            );
            const targetIndex = preset.panes.findIndex(
              (pane) => pane.id === targetId
            );
            if (sourceIndex < 0 || targetIndex < 0) return preset;
            const panes = [...preset.panes];
            [panes[sourceIndex], panes[targetIndex]] = [
              panes[targetIndex],
              panes[sourceIndex],
            ];
            return { ...preset, panes };
          })
        ),
      setHorizontalSizes: (sizes, offset = 0) =>
        set((state) =>
          updateCurrentPreset(state, (preset) => {
            const horizontalSizes = [...(preset.horizontalSizes ?? [])];
            sizes.forEach((size, index) => {
              horizontalSizes[offset + index] = size;
            });
            return { ...preset, horizontalSizes };
          })
        ),
      setVerticalSizes: (verticalSizes) =>
        set((state) =>
          updateCurrentPreset(state, (preset) => ({
            ...preset,
            verticalSizes,
          }))
        ),
    }),
    {
      name: 'vk-split-screen-v1',
      version: 1,
      partialize: ({ activeUserId, preset, presets }) => ({
        activeUserId,
        preset,
        presets,
      }),
    }
  )
);
