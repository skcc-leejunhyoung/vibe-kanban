import { describe, expect, it } from 'vitest';
import { hexToHslString, hslStringToHex } from '@vibe/ui/lib/colors';
import { PRESET_COLORS, pickUnusedColor } from './colors';

const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

describe('pickUnusedColor', () => {
  it('picks the only preset not already in use', () => {
    const used = PRESET_COLORS.slice(0, -1);
    expect(pickUnusedColor([...used])).toBe(
      PRESET_COLORS[PRESET_COLORS.length - 1]
    );
  });

  it('generates a distant hue when every preset is taken', () => {
    const color = pickUnusedColor([...PRESET_COLORS]);
    expect(color).toMatch(/^\d+ \d+% \d+%$/);
    const hue = Number.parseFloat(color);
    for (const preset of PRESET_COLORS) {
      expect(hueDistance(hue, Number.parseFloat(preset))).toBeGreaterThan(20);
    }
  });
});

describe('hex/hsl conversion', () => {
  it('round-trips the backlog gray', () => {
    expect(hslStringToHex('220 9% 46%')).toBe('#6b7280');
    expect(hexToHslString('#6b7280')).toBe('220 9% 46%');
  });

  it('handles achromatic and primary colors', () => {
    expect(hexToHslString('#000000')).toBe('0 0% 0%');
    expect(hexToHslString('#ffffff')).toBe('0 0% 100%');
    expect(hexToHslString('#ff0000')).toBe('0 100% 50%');
  });

  it('returns null for non-HSL strings', () => {
    expect(hslStringToHex('#ff0000')).toBeNull();
  });
});
