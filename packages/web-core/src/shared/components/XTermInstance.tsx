import { useCallback, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

import { useTheme } from '@/shared/hooks/useTheme';
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_SCROLLBACK,
  getTerminalFontSize,
  getTerminalTheme,
} from '@/shared/lib/terminalTheme';
import { useTerminal } from '@/shared/hooks/useTerminal';

interface XTermInstanceProps {
  tabId: string;
  /** Omit for a standalone terminal: the server then starts it in `$HOME`. */
  workspaceId?: string;
  isActive: boolean;
  onClose?: () => void;
}

function terminalEndpoint(
  workspaceId: string | undefined,
  cols: number,
  rows: number
): string {
  const params = new URLSearchParams({
    cols: String(cols),
    rows: String(rows),
  });
  if (workspaceId) params.set('workspace_id', workspaceId);
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${window.location.host}/api/terminal/ws?${params}`;
}

export function XTermInstance({
  tabId,
  workspaceId,
  isActive,
  onClose,
}: XTermInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { theme } = useTheme();
  const {
    registerTerminalInstance,
    getTerminalInstance,
    createTerminalConnection,
    getTerminalConnection,
  } = useTerminal();

  // Kept in a ref so a fresh inline `onClose` from the parent never tears down
  // and re-attaches the terminal.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const fitTerminal = useCallback(() => {
    fitAddonRef.current?.fit();
    if (terminalRef.current) {
      const conn = getTerminalConnection(tabId);
      conn?.resize(terminalRef.current.cols, terminalRef.current.rows);
    }
  }, [tabId, getTerminalConnection]);

  useEffect(() => {
    if (!containerRef.current) return;

    const existing = getTerminalInstance(tabId);
    if (existing) {
      const { terminal, fitAddon } = existing;
      if (terminal.element) {
        containerRef.current.appendChild(terminal.element);
        fitAddon.fit();
      }
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      return;
    }

    if (terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: getTerminalFontSize(),
      fontFamily: TERMINAL_FONT_FAMILY,
      scrollback: TERMINAL_SCROLLBACK,
      // Lets Alt+←/→ reach zsh as word-motions instead of being eaten by macOS.
      macOptionIsMeta: true,
      theme: getTerminalTheme(),
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);

    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // xterm measures the cell box from the font that is loaded *now*; if the
    // terminal font is still loading it measures the fallback and the whole
    // grid stays misaligned. Re-fit once the real metrics are available.
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (disposed) return;
      fitAddon.fit();
      getTerminalConnection(tabId)?.resize(terminal.cols, terminal.rows);
    });

    if (!getTerminalConnection(tabId)) {
      // Connect only after fitting, so the PTY is spawned at the real size and
      // the shell's first prompt is never drawn against a stale 80x24 grid.
      createTerminalConnection(
        tabId,
        terminalEndpoint(workspaceId, terminal.cols, terminal.rows),
        (data) => terminal.write(data),
        () => onCloseRef.current?.()
      );
    }

    registerTerminalInstance(tabId, terminal, fitAddon);

    terminal.onData((data) => {
      const conn = getTerminalConnection(tabId);
      conn?.send(data);
    });

    return () => {
      disposed = true;
      if (terminal.element && terminal.element.parentNode) {
        terminal.element.parentNode.removeChild(terminal.element);
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    tabId,
    workspaceId,
    getTerminalInstance,
    registerTerminalInstance,
    createTerminalConnection,
    getTerminalConnection,
  ]);

  useEffect(() => {
    if (!resizeRef.current) return;
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(resizeRef.current);
    return () => observer.disconnect();
  }, [fitTerminal]);

  // App zoom rewrites the root font size on <html>; follow it so the terminal
  // does not stay pinned at its unzoomed size while the rest of the UI scales.
  useEffect(() => {
    const applyFontSize = () => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const fontSize = getTerminalFontSize();
      if (terminal.options.fontSize === fontSize) return;
      terminal.options.fontSize = fontSize;
      fitTerminal();
    };
    applyFontSize();
    const observer = new MutationObserver(applyFontSize);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    });
    return () => observer.disconnect();
  }, [fitTerminal]);

  useEffect(() => {
    if (isActive) terminalRef.current?.focus();
  }, [isActive]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme();
    }
  }, [theme]);

  return (
    <div ref={resizeRef} className="w-full h-full px-2 py-1">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
