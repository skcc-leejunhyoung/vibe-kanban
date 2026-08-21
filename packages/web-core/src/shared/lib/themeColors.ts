import { ThemeMode } from 'shared/types';

export const DEFAULT_PRIMARY_COLOR = '#d9772d';

const HEX_COLOR_RE = /^#([0-9a-f]{6})$/i;

type HslColor = {
  h: number;
  s: number;
  l: number;
};

function normalizeHexColor(color: string | null | undefined): string {
  if (!color) return DEFAULT_PRIMARY_COLOR;

  const trimmed = color.trim();
  const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return HEX_COLOR_RE.test(prefixed)
    ? prefixed.toLowerCase()
    : DEFAULT_PRIMARY_COLOR;
}

function hexToHsl(hexColor: string): HslColor {
  const normalized = normalizeHexColor(hexColor).slice(1);
  const r = parseInt(normalized.slice(0, 2), 16) / 255;
  const g = parseInt(normalized.slice(2, 4), 16) / 255;
  const b = parseInt(normalized.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }

    h /= 6;
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

function getRelativeLuminance(hexColor: string): number {
  const normalized = normalizeHexColor(hexColor).slice(1);
  const channels = [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ].map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4);
  });

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function formatHsl({ h, s, l }: HslColor): string {
  return `${h} ${s}% ${l}%`;
}

// --- HSL triple <-> hex conversion (used by the theme preset editor) ---
//
// Design tokens are stored either as an HSL triple ("211 60% 7%", consumed by
// `hsl(var(--token))`) or as a hex string ("#ff7b9c", for syntax colors). The
// editor speaks hex (native <input type="color">), so we convert in both
// directions here.

const HSL_TRIPLE_RE =
  /^\s*(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*$/;

export function isHslTriple(value: string): boolean {
  return HSL_TRIPLE_RE.test(value);
}

function parseHslTriple(value: string): HslColor | null {
  const match = value.match(HSL_TRIPLE_RE);
  if (!match) return null;
  return {
    h: Number(match[1]),
    s: Number(match[2]),
    l: Number(match[3]),
  };
}

function hslToRgb({ h, s, l }: HslColor): [number, number, number] {
  const sat = s / 100;
  const lum = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lum, 1 - lum);
  const f = (n: number) =>
    lum - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255),
  ];
}

function toHexChannel(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
}

/** Convert an HSL triple ("211 60% 7%") to a hex string ("#0a1622"). */
export function hslTripleToHex(value: string): string {
  const hsl = parseHslTriple(value);
  if (!hsl) {
    // Already hex (or unparseable) — normalize and return.
    return normalizeHexColor(value);
  }
  const [r, g, b] = hslToRgb(hsl);
  return `#${toHexChannel(r)}${toHexChannel(g)}${toHexChannel(b)}`;
}

/** Convert a hex string ("#0a1622") to an HSL triple ("211 60% 7%"). */
export function hexToHslTriple(hexColor: string): string {
  return formatHsl(hexToHsl(hexColor));
}

export function isValidPrimaryColor(color: string): boolean {
  return HEX_COLOR_RE.test(color.trim());
}

export function normalizePrimaryColor(color: string): string {
  return normalizeHexColor(color);
}

export function applyPrimaryColor(color: string | null | undefined) {
  const normalizedColor = normalizeHexColor(color);
  const brand = hexToHsl(normalizedColor);
  const root = window.document.documentElement;

  root.style.setProperty('--brand', formatHsl(brand));
  root.style.setProperty(
    '--brand-hover',
    formatHsl({ ...brand, l: Math.min(brand.l + 8, 92) })
  );
  root.style.setProperty(
    '--brand-secondary',
    formatHsl({ ...brand, l: Math.max(brand.l - 17, 18) })
  );
  root.style.setProperty(
    '--text-on-brand',
    getRelativeLuminance(normalizedColor) > 0.45 ? '0 0% 5%' : '0 0% 100%'
  );
}

const PRIMARY_COLOR_STORAGE_KEY = 'vk-primary-color';

// Cache the chosen color locally so it can be applied before first paint on
// any route — including ones that don't load server config (e.g. remote
// /projects/$projectId, which has no hostId).
export function persistPrimaryColor(color: string | null | undefined) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      PRIMARY_COLOR_STORAGE_KEY,
      normalizeHexColor(color)
    );
  } catch {
    // ignore storage errors (private mode / quota)
  }
}

export function loadPersistedPrimaryColor(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(PRIMARY_COLOR_STORAGE_KEY);
  } catch {
    return null;
  }
}

// --- theme mode (dark / light / system) ---

const THEME_STORAGE_KEY = 'vk-theme';

let systemThemeQuery: MediaQueryList | null = null;
let systemThemeHandler: ((event: MediaQueryListEvent) => void) | null = null;

// Paint the browser / installed-PWA chrome to match the app's *active*
// background. macOS Safari PWAs color the window title bar from
// `<meta name="theme-color">`; iOS/Android use it for the status / address bar.
// A media-scoped meta only follows the OS color-scheme, so it drifts whenever
// the in-app theme differs from the OS (e.g. OS light + app forced dark, or a
// theme-variant "skin"). Reading the computed background of <body> instead
// tracks the real rendered theme — light/dark mode, skins, and any host
// override — so the title bar always matches the page.
export function syncThemeColorMeta() {
  if (typeof document === 'undefined') return;
  const el = document.body ?? document.documentElement;
  if (!el) return;
  const color = window.getComputedStyle(el).backgroundColor;
  // Skip transparent/empty values (e.g. before styles load) so we don't paint
  // the chrome black.
  if (!color || color === 'rgba(0, 0, 0, 0)' || color === 'transparent') return;
  let meta = document.head.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]:not([media])'
  );
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  if (meta.content !== color) meta.content = color;
}

function setThemeClass(resolved: 'light' | 'dark') {
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
  // The class drives `bg-background`, so the computed background is now correct.
  syncThemeColorMeta();
}

// Apply the theme to <html>. SYSTEM (or unset) follows prefers-color-scheme and
// live-updates on OS changes; DARK/LIGHT are forced. Replaces useSystemTheme so
// an explicit user choice is honored on the remote web too.
export function applyTheme(theme: ThemeMode | string | null | undefined) {
  if (typeof window === 'undefined') return;

  if (systemThemeQuery && systemThemeHandler) {
    systemThemeQuery.removeEventListener('change', systemThemeHandler);
    systemThemeHandler = null;
  }

  if (!theme || theme === ThemeMode.SYSTEM) {
    systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setThemeClass(systemThemeQuery.matches ? 'dark' : 'light');
    systemThemeHandler = (event) =>
      setThemeClass(event.matches ? 'dark' : 'light');
    systemThemeQuery.addEventListener('change', systemThemeHandler);
    return;
  }

  setThemeClass(theme === ThemeMode.DARK ? 'dark' : 'light');
}

export function persistTheme(theme: ThemeMode | string | null | undefined) {
  if (typeof window === 'undefined' || !theme) return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore storage errors (private mode / quota)
  }
}

export function loadPersistedTheme(): ThemeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const theme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return Object.values(ThemeMode).includes(theme as ThemeMode)
      ? (theme as ThemeMode)
      : null;
  } catch {
    return null;
  }
}
