import { describe, expect, it } from 'vitest';
import {
  getNextNotificationIndex,
  isNotificationActivationKey,
} from './notificationKeyboardNavigation';

describe('getNextNotificationIndex', () => {
  it('starts at the edge matching the navigation direction', () => {
    expect(getNextNotificationIndex(3, -1, 'next')).toBe(0);
    expect(getNextNotificationIndex(3, -1, 'previous')).toBe(2);
  });

  it('moves between notifications and wraps at the edges', () => {
    expect(getNextNotificationIndex(3, 0, 'next')).toBe(1);
    expect(getNextNotificationIndex(3, 2, 'next')).toBe(0);
    expect(getNextNotificationIndex(3, 0, 'previous')).toBe(2);
  });

  it('returns null for an empty list', () => {
    expect(getNextNotificationIndex(0, -1, 'next')).toBeNull();
  });
});

describe('isNotificationActivationKey', () => {
  it('activates a focused notification with Return or Space', () => {
    expect(isNotificationActivationKey('Enter')).toBe(true);
    expect(isNotificationActivationKey(' ')).toBe(true);
    expect(isNotificationActivationKey('ArrowDown')).toBe(false);
  });
});
