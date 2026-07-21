import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const MIN_SPLIT_PANES = 1;
export const MAX_SPLIT_PANES = 9;
export const DEFAULT_MAX_SPLIT_PANES = 4;
export const SPLIT_PRESETS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type SplitPreset = (typeof SPLIT_PRESETS)[number];

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
  maxPanes: SplitPreset;
  presets: PresetStates;
  syncUser: (userId: string | null) => void;
  setPreset: (preset: SplitPreset, currentUrl: string) => void;
  setMaxPanes: (maxPanes: SplitPreset) => void;
  openPane: (url: string, currentUrl: string) => 'pane' | 'overflow';
  openPaneInWindow: (url: string) => void;
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

const initialPresets = (): PresetStates =>
  Object.fromEntries(
    SPLIT_PRESETS.map((preset) => [preset, makePreset(preset)])
  ) as unknown as PresetStates;

function isSplitPreset(value: number): value is SplitPreset {
  return value >= MIN_SPLIT_PANES && value <= MAX_SPLIT_PANES;
}

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
      maxPanes: DEFAULT_MAX_SPLIT_PANES,
      presets: initialPresets(),
      syncUser: (userId) =>
        set((state) => {
          if (state.activeUserId === userId) return state;
          return {
            activeUserId: userId,
            preset: 1,
            maxPanes: state.maxPanes,
            presets: initialPresets(),
          };
        }),
      setMaxPanes: (maxPanes) =>
        set((state) => {
          if (state.preset <= maxPanes) return { maxPanes };
          const source = state.presets[state.preset];
          const destination = state.presets[maxPanes];
          return {
            maxPanes,
            preset: maxPanes,
            presets: {
              ...state.presets,
              [maxPanes]: {
                ...destination,
                activePaneId: destination.panes[0].id,
                panes: destination.panes.map((pane, index) => ({
                  ...pane,
                  url: source.panes[index]?.url ?? pane.url,
                })),
              },
            },
          };
        }),
      openPane: (url, currentUrl) => {
        let result: 'pane' | 'overflow' = 'overflow';
        set((state) => {
          if (state.preset >= state.maxPanes) return state;
          const nextPresetValue = state.preset + 1;
          if (!isSplitPreset(nextPresetValue)) return state;

          const source = state.presets[state.preset];
          const sourceUrls = source.panes.map((pane) => pane.url ?? currentUrl);
          const destination = state.presets[nextPresetValue];
          result = 'pane';
          return {
            preset: nextPresetValue,
            presets: {
              ...state.presets,
              [nextPresetValue]: {
                ...destination,
                activePaneId:
                  destination.panes[sourceUrls.length]?.id ??
                  destination.activePaneId,
                panes: destination.panes.map((pane, index) => ({
                  ...pane,
                  url: index < sourceUrls.length ? sourceUrls[index] : url,
                })),
              },
            },
          };
        });
        return result;
      },
      setPreset: (preset, currentUrl) =>
        set((state) => {
          if (preset > state.maxPanes) return state;
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
      openPaneInWindow: (url) =>
        set((state) => ({
          preset: 1,
          presets: {
            ...state.presets,
            1: {
              ...state.presets[1],
              activePaneId: state.presets[1].panes[0].id,
              panes: state.presets[1].panes.map((pane, index) => ({
                ...pane,
                url: index === 0 ? url : pane.url,
              })),
            },
          },
        })),
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
      version: 2,
      migrate: (persisted) => {
        const state = persisted as Partial<SplitScreenState>;
        return {
          ...state,
          maxPanes: state.maxPanes ?? DEFAULT_MAX_SPLIT_PANES,
          presets: { ...initialPresets(), ...state.presets },
        } as SplitScreenState;
      },
      partialize: ({ activeUserId, preset, maxPanes, presets }) => ({
        activeUserId,
        preset,
        maxPanes,
        presets,
      }),
    }
  )
);
