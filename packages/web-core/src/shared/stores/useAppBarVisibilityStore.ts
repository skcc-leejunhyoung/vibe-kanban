import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

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
      name: 'vk-app-bar-visibility-v1',
      storage: createJSONStorage(() => window.sessionStorage),
    }
  )
);
