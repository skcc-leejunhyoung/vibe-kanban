import { create } from 'zustand';
import type { ProjectViewLayout } from './useUiPreferencesStore';

/**
 * Lightweight view metadata published by the mounted KanbanContainer so the
 * command palette "Select view" action can list and switch the current
 * project's views without reaching into the ProjectProvider/Electric context.
 */
export type ProjectViewSwitcherItem = {
  id: string;
  name: string;
  layout: ProjectViewLayout;
};

type State = {
  projectId: string | null;
  views: ProjectViewSwitcherItem[];
  activeViewId: string | null;
  setSwitcherState: (payload: {
    projectId: string;
    views: ProjectViewSwitcherItem[];
    activeViewId: string;
  }) => void;
  clear: () => void;
};

export const useProjectViewSwitcherStore = create<State>((set) => ({
  projectId: null,
  views: [],
  activeViewId: null,
  setSwitcherState: (payload) => set(payload),
  clear: () => set({ projectId: null, views: [], activeViewId: null }),
}));
