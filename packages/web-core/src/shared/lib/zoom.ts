import { isStandalonePwa, isTauriApp } from './platform';

const ZOOM_STORAGE_KEY = 'vk-zoom-level';
const TEXT_SCALE_STORAGE_KEY = 'vk-text-scale';
const TEXT_SCALE_PROPERTY = '--vk-text-scale';
const ZOOM_EVENT = 'vk-zoom-change';
const DEFAULT_FONT_SIZE = 16;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
const STEP = 1;
const TEXT_STEP = 10;

const toPercent = (size: number) =>
  Math.round((size / DEFAULT_FONT_SIZE) * 100);

export const MIN_ZOOM_PERCENT = toPercent(MIN_FONT_SIZE);
export const MAX_ZOOM_PERCENT = toPercent(MAX_FONT_SIZE);
export const DEFAULT_ZOOM_PERCENT = toPercent(DEFAULT_FONT_SIZE);
export const MIN_TEXT_PERCENT = MIN_ZOOM_PERCENT;
export const MAX_TEXT_PERCENT = MAX_ZOOM_PERCENT;
export const DEFAULT_TEXT_PERCENT = DEFAULT_ZOOM_PERCENT;

const clampFontSize = (size: number) =>
  Math.min(Math.max(size, MIN_FONT_SIZE), MAX_FONT_SIZE);

function loadFontSize(): number {
  try {
    const stored = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (stored) {
      // Round: a hand-edited fractional level would reintroduce the blurry
      // hairlines the integer steps exist to avoid.
      const size = Math.round(Number(stored));
      if (size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE) return size;
    }
  } catch {
    // localStorage may be unavailable
  }
  return DEFAULT_FONT_SIZE;
}

// Every rem-based font-size utility multiplies by `--vk-text-scale` (see
// fontSize in tailwind.new.config.js), while spacing, icons and controls follow
// the root font size alone. The scale is kept relative to the root size, so
// zoom still moves text and UI together and only the UI-size steps have to
// compensate to hold the text still.
function loadTextScale(): number {
  try {
    const scale = Number(localStorage.getItem(TEXT_SCALE_STORAGE_KEY));
    // Only scales the steppers can produce: a hand-edited 50 would otherwise
    // render every text, the settings dialog included, at 50x.
    if (
      scale >= textScaleFor(MIN_TEXT_PERCENT, MAX_FONT_SIZE) &&
      scale <= textScaleFor(MAX_TEXT_PERCENT, MIN_FONT_SIZE)
    ) {
      return scale;
    }
  } catch {
    // localStorage may be unavailable
  }
  return 1;
}

function persist(key: string, value: number, defaultValue: number): void {
  try {
    if (value === defaultValue) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, String(value));
    }
  } catch {
    // localStorage may be unavailable
  }
}

function applyFontSize(size: number): void {
  document.documentElement.style.fontSize = `${size}px`;
}

function applyTextScale(scale: number): void {
  const { style } = document.documentElement;
  if (scale === 1) {
    style.removeProperty(TEXT_SCALE_PROPERTY);
  } else {
    style.setProperty(TEXT_SCALE_PROPERTY, String(scale));
  }
}

let currentFontSize: number | null = null;
let currentTextScale: number | null = null;

function fontSize(): number {
  return (currentFontSize ??= loadFontSize());
}

/** Multiplier applied to rem-based font sizes on top of the root font size. */
export function getTextScale(): number {
  return (currentTextScale ??= loadTextScale());
}

function setSizes(size: number, textScale: number): void {
  currentFontSize = clampFontSize(size);
  currentTextScale = textScale;
  applyFontSize(currentFontSize);
  applyTextScale(currentTextScale);
  persist(ZOOM_STORAGE_KEY, currentFontSize, DEFAULT_FONT_SIZE);
  persist(TEXT_SCALE_STORAGE_KEY, currentTextScale, 1);
  window.dispatchEvent(new Event(ZOOM_EVENT));
}

// Text scale that renders text at `percent` of its default size on a root font
// size of `size`, rounded so the stored/CSS value stays readable.
const textScaleFor = (percent: number, size: number) =>
  Math.round((percent / 100) * (DEFAULT_FONT_SIZE / size) * 1e4) / 1e4;

// Zoom moves text and UI together, like browser zoom.
export function zoomIn(): void {
  setSizes(fontSize() + STEP, getTextScale());
}

export function zoomOut(): void {
  setSizes(fontSize() - STEP, getTextScale());
}

export function zoomReset(): void {
  setSizes(DEFAULT_FONT_SIZE, 1);
}

/** Size of spacing, icons and controls, as a percentage of the default. */
export function getZoomPercent(): number {
  return toPercent(fontSize());
}

/** Rendered text size as a percentage of the default, whatever the zoom. */
export function getTextPercent(): number {
  return Math.round((fontSize() / DEFAULT_FONT_SIZE) * getTextScale() * 100);
}

function setTextPercent(percent: number): void {
  const clamped = Math.min(
    Math.max(percent, MIN_TEXT_PERCENT),
    MAX_TEXT_PERCENT
  );
  setSizes(fontSize(), textScaleFor(clamped, fontSize()));
}

// Text only: spacing, icons and controls keep their size.
export function textSizeIn(): void {
  setTextPercent(getTextPercent() + TEXT_STEP);
}

export function textSizeOut(): void {
  setTextPercent(getTextPercent() - TEXT_STEP);
}

export function textSizeReset(): void {
  setTextPercent(DEFAULT_TEXT_PERCENT);
}

// UI only: the root font size steps while the text scale compensates, so text
// keeps its rendered size.
function setUiSize(size: number): void {
  const clamped = clampFontSize(size);
  setSizes(clamped, textScaleFor(getTextPercent(), clamped));
}

export function uiSizeIn(): void {
  setUiSize(fontSize() + STEP);
}

export function uiSizeOut(): void {
  setUiSize(fontSize() - STEP);
}

export function uiSizeReset(): void {
  setUiSize(DEFAULT_FONT_SIZE);
}

export function subscribeZoom(onChange: () => void): () => void {
  window.addEventListener(ZOOM_EVENT, onChange);
  return () => window.removeEventListener(ZOOM_EVENT, onChange);
}

// Whether app zoom replaces native browser zoom in this context.
function isAppZoomEnabled(): boolean {
  return isTauriApp() || isStandalonePwa();
}

// Applies the stored text/UI sizes (adjustable from settings in every context)
// and, in app-like contexts (Tauri, installed PWA), replaces native zoom with
// custom zoom (Cmd/Ctrl + =/–/0) via root font-size scaling. Integer font-size
// steps keep 1px hairlines and layout pixel-exact, whereas native page zoom
// uses fractional scale factors that render blurry on non-retina displays — and
// Safari's trackpad pinch is a bitmap magnification that never re-rasterizes.
// Pinch-to-zoom is blocked for the same reason.
export function installAppZoom(): void {
  if (fontSize() !== DEFAULT_FONT_SIZE) applyFontSize(fontSize());
  if (getTextScale() !== 1) applyTextScale(getTextScale());

  if (!isAppZoomEnabled()) return;

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
