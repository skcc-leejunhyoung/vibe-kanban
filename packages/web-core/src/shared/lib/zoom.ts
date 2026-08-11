import { isStandalonePwa, isTauriApp } from './platform';

const ZOOM_STORAGE_KEY = 'vk-zoom-level';
const DEFAULT_FONT_SIZE = 16;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
const STEP = 1;

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

let currentFontSize = DEFAULT_FONT_SIZE;

function zoomIn(): void {
  currentFontSize = Math.min(currentFontSize + STEP, MAX_FONT_SIZE);
  applyFontSize(currentFontSize);
  saveFontSize(currentFontSize);
}

function zoomOut(): void {
  currentFontSize = Math.max(currentFontSize - STEP, MIN_FONT_SIZE);
  applyFontSize(currentFontSize);
  saveFontSize(currentFontSize);
}

function zoomReset(): void {
  currentFontSize = DEFAULT_FONT_SIZE;
  applyFontSize(currentFontSize);
  saveFontSize(currentFontSize);
}

function initZoom(): void {
  currentFontSize = loadFontSize();
  if (currentFontSize !== DEFAULT_FONT_SIZE) {
    applyFontSize(currentFontSize);
  }
}

// Custom zoom (Cmd/Ctrl + =/–/0) via root font-size scaling, replacing native
// zoom in app-like contexts (Tauri, installed PWA). Integer font-size steps
// keep 1px hairlines and layout pixel-exact, whereas native page zoom uses
// fractional scale factors that render blurry on non-retina displays — and
// Safari's trackpad pinch is a bitmap magnification that never re-rasterizes.
// Pinch-to-zoom is blocked for the same reason.
export function installAppZoom(): void {
  if (!isTauriApp() && !isStandalonePwa()) return;

  initZoom();

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
