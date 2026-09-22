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
  subscribeTerminalFontSize,
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
    resizeTerminal,
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
      resizeTerminal(tabId, terminalRef.current.cols, terminalRef.current.rows);
    }
  }, [tabId, resizeTerminal]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const existing = getTerminalInstance(tabId);
    if (existing) {
      const { terminal, fitAddon } = existing;
      if (terminal.element) {
        container.appendChild(terminal.element);
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
      // macOptionIsMeta stays off on purpose. On macOS Option is a third-level
      // shift — it is how the Korean IME types Latin letters without leaving
      // Hangul mode — and turning it into Meta sends ESC+<key> instead, so
      // Option+L fires whatever `bindkey "^[l"` is bound to. Alt+←/→ keep
      // working regardless: xterm builds those from the modifier bitmask and
      // rewrites Alt+Arrow to ESC b / ESC f on macOS.
      theme: getTerminalTheme(),
    });

    // xterm swallows every key it handles — it calls preventDefault *and*
    // stopPropagation — so a focused terminal would eat Ctrl+Tab before the
    // document-level pane shortcut ever sees it, and send a plain tab to the
    // shell instead. Returning false here makes xterm skip the event entirely
    // and let it bubble. Plain Tab / Shift+Tab stay with the shell: those are
    // completion. Ctrl/Cmd+Tab has no shell meaning anywhere.
    terminal.attachCustomKeyEventHandler(
      (event) => !(event.key === 'Tab' && (event.ctrlKey || event.metaKey))
    );

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(container);

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
      // The terminal font is a webfont here, so this refit usually lands while
      // the socket is still connecting — resizeTerminal records it either way.
      resizeTerminal(tabId, terminal.cols, terminal.rows);
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
      // Detach only while this mount still owns the element. xterm keeps one
      // DOM node per terminal, and another mount of the same tab — the right
      // sidebar swapping with the expanded terminal panel — may already have
      // adopted it; an unconditional removeChild would rip it back out and
      // leave that panel blank.
      if (terminal.element?.parentNode === container) {
        container.removeChild(terminal.element);
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
    resizeTerminal,
  ]);

  useEffect(() => {
    if (!resizeRef.current) return;
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(resizeRef.current);
    return () => observer.disconnect();
  }, [fitTerminal]);

  // Two inputs move the cell size: the settings font-size control, and app zoom
  // rewriting the root font size on <html> — follow both, or the terminal stays
  // pinned at its old size while the rest of the UI scales.
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
    const unsubscribe = subscribeTerminalFontSize(applyFontSize);
    return () => {
      observer.disconnect();
      unsubscribe();
    };
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
