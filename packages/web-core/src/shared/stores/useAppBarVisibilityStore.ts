import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const STORAGE_NAME = 'vk-app-bar-visibility-v1';
const EMBED_PARAM = 'vk_split_embed';
const PANE_PARAM = 'vk_split_pane';
const WINDOW_NAME_PREFIX = 'vk-split-pane:';

interface AppBarVisibilityState {
  isVisible: boolean;
  toggle: () => void;
}

export function getAppBarVisibilityStorageName(
  search: string,
  windowName: string
): string {
  const params = new URLSearchParams(search);
  const queryPaneId =
    params.get(EMBED_PARAM) === '1' ? params.get(PANE_PARAM) : null;
  const namedPaneId = windowName.startsWith(WINDOW_NAME_PREFIX)
    ? windowName.slice(WINDOW_NAME_PREFIX.length)
    : null;
  const paneId = queryPaneId || namedPaneId;

  return paneId
    ? `${STORAGE_NAME}:${encodeURIComponent(paneId)}`
    : STORAGE_NAME;
}

function getCurrentAppBarVisibilityStorageName(): string {
  return typeof window === 'undefined'
    ? STORAGE_NAME
    : getAppBarVisibilityStorageName(window.location.search, window.name);
}

export const useAppBarVisibilityStore = create<AppBarVisibilityState>()(
  persist(
    (set) => ({
      isVisible: true,
      toggle: () => set((state) => ({ isVisible: !state.isVisible })),
    }),
    {
      name: getCurrentAppBarVisibilityStorageName(),
      storage: createJSONStorage(() => window.sessionStorage),
    }
  )
);
