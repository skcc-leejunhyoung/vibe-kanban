import { useContext } from 'react';
import { createHmrContext } from '@/shared/lib/hmrContext';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

export interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
}

/** Tabs carry nothing but identity — the panel renders one terminal per id. */
export interface TerminalTab {
  id: string;
}

interface TerminalConnection {
  ws: WebSocket;
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
}

export interface TerminalContextType {
  getTabsForWorkspace: (workspaceId: string) => TerminalTab[];
  getActiveTab: (workspaceId: string) => TerminalTab | null;
  createTab: (workspaceId: string) => void;
  closeTab: (workspaceId: string, tabId: string) => void;
  clearWorkspaceTabs: (workspaceId: string) => void;
  registerTerminalInstance: (
    tabId: string,
    terminal: Terminal,
    fitAddon: FitAddon
  ) => void;
  getTerminalInstance: (tabId: string) => TerminalInstance | null;
  createTerminalConnection: (
    tabId: string,
    endpoint: string,
    onData: (data: Uint8Array) => void,
    onExit?: () => void
  ) => {
    send: (data: string) => void;
    resize: (cols: number, rows: number) => void;
  };
  getTerminalConnection: (tabId: string) => TerminalConnection | null;
  /** Resize the PTY, remembering the size so a connect/reconnect replays it. */
  resizeTerminal: (tabId: string, cols: number, rows: number) => void;
}

export const TerminalContext = createHmrContext<TerminalContextType | null>(
  'TerminalContext',
  null
);

export function useTerminal() {
  const context = useContext(TerminalContext);
  if (!context) {
    throw new Error('useTerminal must be used within TerminalProvider');
  }
  return context;
}
