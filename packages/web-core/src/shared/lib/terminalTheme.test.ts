import { describe, expect, it } from 'vitest';
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
