import { isStandalonePwa, isTauriApp } from './platform';

const ZOOM_STORAGE_KEY = 'vk-zoom-level';
const ZOOM_EVENT = 'vk-zoom-change';
const DEFAULT_FONT_SIZE = 16;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
const STEP = 1;

const toPercent = (size: number) =>
  Math.round((size / DEFAULT_FONT_SIZE) * 100);

export const MIN_ZOOM_PERCENT = toPercent(MIN_FONT_SIZE);
export const MAX_ZOOM_PERCENT = toPercent(MAX_FONT_SIZE);
export const DEFAULT_ZOOM_PERCENT = toPercent(DEFAULT_FONT_SIZE);

function loadFontSize(): number {
  try {
    const stored = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (stored) {
      const size = Number(stored);
      if (size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE) return size;
    }
  } catch {
    // localStorage may be unavailable
  }
  return DEFAULT_FONT_SIZE;
}

function saveFontSize(size: number): void {
  try {
    if (size === DEFAULT_FONT_SIZE) {
      localStorage.removeItem(ZOOM_STORAGE_KEY);
    } else {
      localStorage.setItem(ZOOM_STORAGE_KEY, String(size));
    }
  } catch {
    // localStorage may be unavailable
  }
}

function applyFontSize(size: number): void {
  document.documentElement.style.fontSize = `${size}px`;
}

let currentFontSize: number | null = null;

function fontSize(): number {
  return (currentFontSize ??= loadFontSize());
}

function setFontSize(size: number): void {
  currentFontSize = Math.min(Math.max(size, MIN_FONT_SIZE), MAX_FONT_SIZE);
  applyFontSize(currentFontSize);
  saveFontSize(currentFontSize);
  window.dispatchEvent(new Event(ZOOM_EVENT));
}

export function zoomIn(): void {
  setFontSize(fontSize() + STEP);
}

export function zoomOut(): void {
  setFontSize(fontSize() - STEP);
}

export function zoomReset(): void {
  setFontSize(DEFAULT_FONT_SIZE);
}

export function getZoomPercent(): number {
  return toPercent(fontSize());
}

export function subscribeZoom(onChange: () => void): () => void {
  window.addEventListener(ZOOM_EVENT, onChange);
  return () => window.removeEventListener(ZOOM_EVENT, onChange);
}

// Whether app zoom replaces native browser zoom in this context — also gates
// the settings zoom control, which is the only way to zoom an iOS PWA (no
// keyboard, and pinch is blocked below).
export function isAppZoomEnabled(): boolean {
  return isTauriApp() || isStandalonePwa();
}

// Custom zoom (Cmd/Ctrl + =/–/0) via root font-size scaling, replacing native
// zoom in app-like contexts (Tauri, installed PWA). Integer font-size steps
// keep 1px hairlines and layout pixel-exact, whereas native page zoom uses
// fractional scale factors that render blurry on non-retina displays — and
// Safari's trackpad pinch is a bitmap magnification that never re-rasterizes.
// Pinch-to-zoom is blocked for the same reason.
export function installAppZoom(): void {
  if (!isAppZoomEnabled()) return;

  if (fontSize() !== DEFAULT_FONT_SIZE) applyFontSize(fontSize());

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      zoomIn();
    } else if (e.key === '-') {
      e.preventDefault();
      zoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      zoomReset();
    }
  });

  document.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false }
  );
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());
}
