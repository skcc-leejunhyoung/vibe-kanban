import { PRESET_COLORS } from '@vibe/ui/components/ColorPicker';

export { PRESET_COLORS };

/**
 * Pick a color for a new item that doesn't collide with colors already in use.
 * Prefers unused preset colors; once every preset is taken, generates a color
 * whose hue is farthest from all used hues.
 */
export function pickUnusedColor(usedColors: string[]): string {
  const used = new Set(usedColors);
  const unused = PRESET_COLORS.filter((c) => !used.has(c));
  if (unused.length > 0) {
    return unused[Math.floor(Math.random() * unused.length)];
  }
  const usedHues = usedColors
    .map((c) => Number.parseFloat(c))
    .filter(Number.isFinite);
  let bestHue = 0;
  let bestDist = -1;
  for (let h = 0; h < 360; h += 3) {
    const dist = Math.min(
      ...usedHues.map((u) => {
        const d = Math.abs(h - u) % 360;
        return Math.min(d, 360 - d);
      })
    );
    if (dist > bestDist) {
      bestDist = dist;
      bestHue = h;
    }
  }
  return `${bestHue} 70% 50%`;
}
