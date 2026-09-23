import type { ITheme } from '@xterm/xterm';
import { getTextScale } from './zoom';

/**
 * oh-my-zsh themes (powerlevel10k in particular) draw their prompt out of Nerd
 * Font Private Use Area glyphs that plain monospace fonts do not have.
 *
 * Installed Nerd Fonts lead: they are patched full fonts, so their icons carry
 * the same 0.6em advance as their Latin glyphs and land in exactly one xterm
 * cell. The bundled Symbols face sits behind them as the fallback that Safari —
 * which hides user-installed fonts from web content, PWA included — actually
 * gets to use; its unicode-range covers only the icon blocks, so Latin text and
 * therefore xterm's cell metric always come from a real monospace family.
 *
 * Order matters the other way round from what it looks like: the Symbols face
 * is a symbols-only font with a full-em advance (1.0em against a 0.6em cell), so
 * putting it first would make every icon overflow its cell even on browsers that
 * can see a properly patched Nerd Font. Fallback is per character, so sitting
 * late in the list still supplies the glyph wherever nothing earlier resolves.
 */
export const TERMINAL_FONT_FAMILY = [
  '"MesloLGS NF"',
  '"MesloLGS Nerd Font Mono"',
  '"MesloLGM Nerd Font Mono"',
  '"JetBrainsMono Nerd Font Mono"',
  '"FiraCode Nerd Font Mono"',
  '"Hack Nerd Font Mono"',
  '"Symbols Nerd Font Mono"',
  '"IBM Plex Mono"',
  'Menlo',
  'Consolas',
  'monospace',
].join(', ');

/** Deep enough to scroll back through a build log. */
export const TERMINAL_SCROLLBACK = 10000;

const ROOT_BASE_FONT_SIZE = 16;

/** Terminal font size in px at 100% app zoom, before the user adjusts it. */
export const TERMINAL_DEFAULT_FONT_SIZE = 12;
export const TERMINAL_MIN_FONT_SIZE = 8;
export const TERMINAL_MAX_FONT_SIZE = 24;

const FONT_SIZE_STORAGE_KEY = 'vk-terminal-font-size';
const FONT_SIZE_EVENT = 'vk-terminal-font-size-change';

/**
 * App zoom (`installAppZoom`) scales the root font size and the text-size
 * setting multiplies rem-based text on top of it, so every text surface grows
 * with them — except xterm, which sizes its cells in px. Scale the terminal by
 * the same factors, rounded to whole pixels for the same reason the zoom itself
 * steps in integers: fractional cell metrics render blurry.
 */
export function scaleTerminalFontSize(
  rootFontSizePx: number,
  baseFontSizePx: number = TERMINAL_DEFAULT_FONT_SIZE,
  textScale: number = 1
): number {
  if (!Number.isFinite(rootFontSizePx) || rootFontSizePx <= 0) {
    return baseFontSizePx;
  }
  return Math.max(
    6,
    Math.round(
      (baseFontSizePx * rootFontSizePx * textScale) / ROOT_BASE_FONT_SIZE
    )
  );
}

function clampFontSize(size: number): number {
  return Math.min(
    Math.max(Math.round(size), TERMINAL_MIN_FONT_SIZE),
    TERMINAL_MAX_FONT_SIZE
  );
}

function loadFontSize(): number {
  try {
    const stored = Number(localStorage.getItem(FONT_SIZE_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampFontSize(stored);
  } catch {
    // localStorage may be unavailable
  }
  return TERMINAL_DEFAULT_FONT_SIZE;
}

let currentFontSize: number | null = null;

/** The user's terminal font size preference, before app zoom is applied. */
export function getTerminalBaseFontSize(): number {
  return (currentFontSize ??= loadFontSize());
}

export function setTerminalBaseFontSize(size: number): void {
  currentFontSize = clampFontSize(size);
  try {
    if (currentFontSize === TERMINAL_DEFAULT_FONT_SIZE) {
      localStorage.removeItem(FONT_SIZE_STORAGE_KEY);
    } else {
      localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(currentFontSize));
    }
  } catch {
    // localStorage may be unavailable
  }
  window.dispatchEvent(new Event(FONT_SIZE_EVENT));
}

export function subscribeTerminalFontSize(onChange: () => void): () => void {
  window.addEventListener(FONT_SIZE_EVENT, onChange);
  return () => window.removeEventListener(FONT_SIZE_EVENT, onChange);
}

export function getTerminalFontSize(): number {
  return scaleTerminalFontSize(
    parseFloat(getComputedStyle(document.documentElement).fontSize),
    getTerminalBaseFontSize(),
    getTextScale()
  );
}

/**
 * Convert HSL CSS variable value (e.g., "210 40% 98%") to hex color.
 */
function hslToHex(hslValue: string): string {
  const trimmed = hslValue.trim();
  if (!trimmed) return '#000000';

  // Parse "H S% L%" format (space-separated, S and L have % suffix)
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return '#000000';

  const h = parseFloat(parts[0]) / 360;
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;

  // HSL to RGB conversion
  let r: number, g: number, b: number;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (x: number) => {
    const hex = Math.round(x * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Get the CSS variable value from the computed styles.
 */
function getCssVariable(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/**
 * Build an xterm.js theme from CSS variables defined in index.css.
 * Uses --console-background and --console-foreground as the main colors,
 * and derives ANSI colors from a combination of theme-appropriate defaults.
 */
export function getTerminalTheme(): ITheme {
  const background = getCssVariable('--bg-secondary');
  const foreground = getCssVariable('--text-high');
  const success = getCssVariable('--console-success');
  const error = getCssVariable('--console-error');

  // Detect if we're in dark mode by checking the class on html element
  const isDark = document.documentElement.classList.contains('dark');

  // Convert the main colors
  const bgHex = hslToHex(background);
  const fgHex = hslToHex(foreground);
  const greenHex = hslToHex(success);
  const redHex = hslToHex(error);

  // Define ANSI palette based on light/dark mode
  // These are carefully chosen to be readable on the respective backgrounds
  if (isDark) {
    return {
      background: bgHex,
      foreground: fgHex,
      cursor: fgHex,
      cursorAccent: bgHex,
      selectionBackground: '#3d4966',
      selectionForeground: fgHex,
      black: '#1a1a1a',
      red: redHex,
      green: greenHex,
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#c0caf5',
      brightBlack: '#545c7e',
      brightRed: redHex,
      brightGreen: greenHex,
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: fgHex,
    };
  } else {
    // Light mode colors
    return {
      background: bgHex,
      foreground: fgHex,
      cursor: fgHex,
      cursorAccent: bgHex,
      selectionBackground: '#accef7',
      selectionForeground: '#1a1a1a',
      black: '#1a1a1a',
      red: redHex,
      green: greenHex,
      yellow: '#946800',
      blue: '#0550ae',
      magenta: '#a626a4',
      cyan: '#0e7490',
      white: '#57606a',
      brightBlack: '#4b5563',
      brightRed: redHex,
      brightGreen: greenHex,
      brightYellow: '#7c5800',
      brightBlue: '#0969da',
      brightMagenta: '#8250df',
      brightCyan: '#0891b2',
      brightWhite: fgHex,
    };
  }
}
