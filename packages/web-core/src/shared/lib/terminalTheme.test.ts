import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_FONT_FAMILY,
  scaleTerminalFontSize,
} from '@/shared/lib/terminalTheme';

describe('scaleTerminalFontSize', () => {
  it('tracks the app zoom root font size in whole pixels', () => {
    // installAppZoom steps the root font size 8..32px, 16px being unzoomed.
    expect(scaleTerminalFontSize(16)).toBe(12);
    expect(scaleTerminalFontSize(24)).toBe(18);
    expect(scaleTerminalFontSize(8)).toBe(6);
    // Fractional cell metrics render blurry, so every step stays integral.
    expect(Number.isInteger(scaleTerminalFontSize(17))).toBe(true);
  });

  it('falls back to the base size when the root size is unreadable', () => {
    expect(scaleTerminalFontSize(Number.NaN)).toBe(12);
    expect(scaleTerminalFontSize(0)).toBe(12);
  });

  it('scales the user-picked base size, not the built-in one', () => {
    expect(scaleTerminalFontSize(16, 18)).toBe(18);
    expect(scaleTerminalFontSize(24, 18)).toBe(27);
    expect(scaleTerminalFontSize(Number.NaN, 18)).toBe(18);
  });
});

describe('TERMINAL_FONT_FAMILY', () => {
  it('keeps the bundled icon face behind the patched Nerd Fonts', () => {
    // The bundled Symbols face is symbols-only and advances a full em, against
    // a cell sized from a 0.6em Latin font — leading with it makes every icon
    // overflow its cell wherever a patched Nerd Font (0.6em icons) was
    // available. Fallback is per character, so it still supplies the glyph in
    // Safari, which hides user-installed fonts from web content.
    const stack = TERMINAL_FONT_FAMILY.split(', ');
    const symbols = stack.indexOf('"Symbols Nerd Font Mono"');
    expect(symbols).toBeGreaterThan(stack.indexOf('"MesloLGS Nerd Font Mono"'));
    // ...and ahead of every family that has no icons at all, or Safari is back
    // to tofu.
    expect(symbols).toBeLessThan(stack.indexOf('"IBM Plex Mono"'));
    expect(TERMINAL_FONT_FAMILY).toMatch(/monospace$/);
  });
});

// The base size is cached in module state, so each case loads a fresh copy of
// the module against stubbed storage/window globals — same shape as zoom.test.
async function loadTerminalTheme(stored?: string) {
  const store = new Map<string, string>();
  if (stored !== undefined) store.set('vk-terminal-font-size', stored);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('window', new EventTarget());
  vi.resetModules();
  return { mod: await import('./terminalTheme'), store };
}

afterEach(() => vi.unstubAllGlobals());

describe('terminal base font size', () => {
  it('clamps at both ends and rounds to whole pixels', async () => {
    const { mod } = await loadTerminalTheme();
    expect(mod.getTerminalBaseFontSize()).toBe(mod.TERMINAL_DEFAULT_FONT_SIZE);

    mod.setTerminalBaseFontSize(13.6);
    expect(mod.getTerminalBaseFontSize()).toBe(14);
    mod.setTerminalBaseFontSize(0);
    expect(mod.getTerminalBaseFontSize()).toBe(mod.TERMINAL_MIN_FONT_SIZE);
    mod.setTerminalBaseFontSize(999);
    expect(mod.getTerminalBaseFontSize()).toBe(mod.TERMINAL_MAX_FONT_SIZE);
  });

  it('persists a picked size and clears storage on reset', async () => {
    const { mod, store } = await loadTerminalTheme();
    mod.setTerminalBaseFontSize(18);
    expect(store.get('vk-terminal-font-size')).toBe('18');
    mod.setTerminalBaseFontSize(mod.TERMINAL_DEFAULT_FONT_SIZE);
    expect(store.has('vk-terminal-font-size')).toBe(false);
  });

  it('restores a stored size and ignores an unusable one', async () => {
    expect((await loadTerminalTheme('18')).mod.getTerminalBaseFontSize()).toBe(
      18
    );
    // Out of range or hand-edited garbage must not reach xterm as-is.
    expect((await loadTerminalTheme('99')).mod.getTerminalBaseFontSize()).toBe(
      24
    );
    expect((await loadTerminalTheme('abc')).mod.getTerminalBaseFontSize()).toBe(
      12
    );
  });

  it('notifies subscribers until they unsubscribe', async () => {
    const { mod } = await loadTerminalTheme();
    const onChange = vi.fn();
    const unsubscribe = mod.subscribeTerminalFontSize(onChange);
    mod.setTerminalBaseFontSize(14);
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    mod.setTerminalBaseFontSize(16);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
