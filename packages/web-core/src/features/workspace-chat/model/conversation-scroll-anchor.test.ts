import { describe, expect, it } from 'vitest';

import {
  isTopGrowthUpdate,
  topGrowthScrollDelta,
} from './conversation-scroll-anchor';

describe('isTopGrowthUpdate', () => {
  it('flags historic batches as top-growth', () => {
    expect(isTopGrowthUpdate('historic')).toBe(true);
  });

  it('does not flag initial, streaming, or plan updates', () => {
    expect(isTopGrowthUpdate('initial')).toBe(false);
    expect(isTopGrowthUpdate('running')).toBe(false);
    expect(isTopGrowthUpdate('plan')).toBe(false);
  });
});

describe('topGrowthScrollDelta', () => {
  it('returns the positive growth amount', () => {
    expect(topGrowthScrollDelta(1000, 1400)).toBe(400);
  });

  it('returns 0 when the content did not grow', () => {
    expect(topGrowthScrollDelta(1000, 1000)).toBe(0);
  });

  it('ignores shrink (handled by browser clamping)', () => {
    expect(topGrowthScrollDelta(1400, 1000)).toBe(0);
  });
});
