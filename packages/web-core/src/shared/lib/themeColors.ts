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

function setThemeClass(resolved: 'light' | 'dark') {
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
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

export function loadPersistedTheme(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}
