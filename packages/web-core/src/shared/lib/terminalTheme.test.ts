import { describe, expect, it } from 'vitest';
import { scaleTerminalFontSize } from '@/shared/lib/terminalTheme';

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
