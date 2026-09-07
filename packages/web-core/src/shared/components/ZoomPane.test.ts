import { describe, expect, it } from 'vitest';
import { clampView, zoomAbout } from './ZoomPane';

describe('ZoomPane geometry', () => {
  it('keeps the anchor point fixed while scaling and clamps the scale', () => {
    const zoomed = zoomAbout({ s: 1, x: 0, y: 0 }, 2, 100, 50);
    expect(zoomed).toEqual({ s: 2, x: -100, y: -50 });
    // The content point under the anchor (100, 50) is still under it.
    expect(zoomed.x + zoomed.s * 100).toBe(100);
    expect(zoomAbout({ s: 8, x: -10, y: -20 }, 3, 30, 30)).toEqual({
      s: 8,
      x: -10,
      y: -20,
    });
    expect(zoomAbout({ s: 2, x: -100, y: -50 }, 0.1, 100, 50)).toEqual({
      s: 1,
      x: 0,
      y: 0,
    });
  });

  it('centers content that fits and bounds content that overflows', () => {
    expect(clampView({ s: 1, x: -999, y: 999 }, 200, 100, 400, 400)).toEqual({
      s: 1,
      x: 100,
      y: 150,
    });
    expect(clampView({ s: 2, x: 50, y: -1000 }, 300, 300, 400, 400)).toEqual({
      s: 2,
      x: 0,
      y: -200,
    });
  });
});
