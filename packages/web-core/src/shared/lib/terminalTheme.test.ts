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
});

describe('TERMINAL_FONT_FAMILY', () => {
  it('leads with the bundled icon face so Safari still gets Nerd Font glyphs', () => {
    // Safari (PWA included) hides user-installed fonts from web content. The
    // installed Nerd Fonts later in the stack therefore never resolve there,
    // and only a bundled face can supply the powerlevel10k icons. It is
    // unicode-range-limited to the icon blocks, so leading with it does not
    // change which font sets Latin text or the cell metrics.
    expect(TERMINAL_FONT_FAMILY.split(', ')[0]).toBe(
      '"Symbols Nerd Font Mono"'
    );
    expect(TERMINAL_FONT_FAMILY).toMatch(/monospace$/);
  });
});
