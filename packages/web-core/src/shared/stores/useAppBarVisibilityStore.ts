import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const STORAGE_NAME = 'vk-app-bar-visibility-v1';

interface AppBarVisibilityState {
  isVisible: boolean;
  toggle: () => void;
}

export const useAppBarVisibilityStore = create<AppBarVisibilityState>()(
  persist(
    (set) => ({
      isVisible: true,
      toggle: () => set((state) => ({ isVisible: !state.isVisible })),
    }),
    {
      name: STORAGE_NAME,
      storage: createJSONStorage(() => window.sessionStorage),
    }
  )
);
