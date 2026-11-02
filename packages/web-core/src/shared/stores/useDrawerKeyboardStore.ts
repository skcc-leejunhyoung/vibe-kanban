import { create } from 'zustand';

/**
 * Lets the archive shortcut (the workspace one, however it is bound) reach
 * the Drawer: a board in the active pane registers how to archive or restore
 * its focused or open note, and the workspace archive handler tries that
 * first.
 */
interface DrawerKeyboardState {
  archiveOpenNote: (() => void) | null;
  setArchiveOpenNote: (handler: (() => void) | null) => void;
}

export const useDrawerKeyboardStore = create<DrawerKeyboardState>((set) => ({
  archiveOpenNote: null,
  setArchiveOpenNote: (handler) => set({ archiveOpenNote: handler }),
}));
