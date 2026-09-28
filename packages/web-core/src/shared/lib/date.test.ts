import { describe, expect, it } from 'vitest';
import { formatTurnTiming } from './date';

// 01:30Z is 10:30 in the pinned KST display zone.
const START = '2026-09-28T01:30:00Z';

describe('formatTurnTiming', () => {
  it('shows send time, finish time and elapsed once completed', () => {
    const timing = formatTurnTiming(START, '2026-09-28T01:42:03Z', null);
    expect(timing?.text).toBe('10:30 → 10:42 · 12m 3s');
    expect(timing?.title).toContain('→');
  });

  it('ticks elapsed from the clock while still running', () => {
    const now = Date.parse(START) + 3 * 60_000 + 12_000;
    expect(formatTurnTiming(START, null, now)?.text).toBe('10:30 → … · 3m 12s');
  });

  it('never shows a negative elapsed on clock skew', () => {
    expect(formatTurnTiming(START, null, Date.parse(START) - 5000)?.text).toBe(
      '10:30 → … · 0s'
    );
  });

  it('falls back to the send time when neither end nor clock is known', () => {
    expect(formatTurnTiming(START, null, null)?.text).toBe('10:30');
    expect(formatTurnTiming('not a date', null, null)).toBeNull();
  });
});
