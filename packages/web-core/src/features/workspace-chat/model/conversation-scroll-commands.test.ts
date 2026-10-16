import { describe, expect, it } from 'vitest';
import {
  type BottomLockReleaseInput,
  shouldReleaseBottomLock,
} from './conversation-scroll-commands';

// A 600px viewport over 3000px of content; the reader was at the bottom.
const pinned: BottomLockReleaseInput = {
  previousScrollTop: 2400,
  scrollTop: 2400,
  clientHeight: 600,
  scrollHeight: 3000,
  userScrollUntil: 0,
  now: 1000,
  smoothScrollDeadline: 0,
  suppressed: false,
};

describe('shouldReleaseBottomLock', () => {
  it('releases for a wheel scroll that leaves the bottom', () => {
    expect(
      shouldReleaseBottomLock({
        ...pinned,
        scrollTop: 2000,
        userScrollUntil: 1500,
      })
    ).toBe(true);
  });

  it('keeps the lock when the app scrolls up by itself', () => {
    // The chat box shrank and a correction moved the view up 200px.
    expect(shouldReleaseBottomLock({ ...pinned, scrollTop: 2200 })).toBe(false);
    // The gesture window has passed.
    expect(
      shouldReleaseBottomLock({
        ...pinned,
        scrollTop: 2000,
        userScrollUntil: 900,
      })
    ).toBe(false);
  });

  it('keeps the lock while still near the bottom', () => {
    // Content shrank: the browser clamped scrollTop down, view is at bottom.
    expect(
      shouldReleaseBottomLock({
        ...pinned,
        scrollTop: 2300,
        scrollHeight: 2900,
        userScrollUntil: 1500,
      })
    ).toBe(false);
    // A tiny upward wheel tick within the near-bottom threshold.
    expect(
      shouldReleaseBottomLock({
        ...pinned,
        scrollTop: 2360,
        userScrollUntil: 1500,
      })
    ).toBe(false);
  });

  it('keeps the lock during an animation or a correction', () => {
    expect(
      shouldReleaseBottomLock({
        ...pinned,
        scrollTop: 2000,
        userScrollUntil: 1500,
        smoothScrollDeadline: 1200,
      })
    ).toBe(false);
    expect(
      shouldReleaseBottomLock({
        ...pinned,
        scrollTop: 2000,
        userScrollUntil: 1500,
        suppressed: true,
      })
    ).toBe(false);
  });
});
