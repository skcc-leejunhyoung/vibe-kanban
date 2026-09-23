import { create } from 'zustand';

/**
 * Lets the command bar add a shell to the standalone terminal. Actions sit
 * above TerminalProvider, so the terminal registers the handler here while it
 * is on screen; null means no terminal is open and opening one is enough.
 */
interface HomeTerminalState {
  addSession: (() => void) | null;
}

export const useHomeTerminalStore = create<HomeTerminalState>(() => ({
  addSession: null,
}));
