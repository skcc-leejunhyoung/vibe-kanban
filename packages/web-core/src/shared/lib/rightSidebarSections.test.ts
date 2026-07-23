import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RIGHT_SIDEBAR_SECTION_ORDER,
  normalizeRightSidebarSectionOrder,
} from './rightSidebarSections';

describe('normalizeRightSidebarSectionOrder', () => {
  it('uses Git before Commits in the default order', () => {
    const order = normalizeRightSidebarSectionOrder(undefined);

    expect(order).toEqual(DEFAULT_RIGHT_SIDEBAR_SECTION_ORDER);
    expect(order.indexOf('git')).toBeLessThan(order.indexOf('commits'));
  });

  it('preserves valid user order and repairs stale values', () => {
    expect(
      normalizeRightSidebarSectionOrder([
        'notes',
        'commits',
        'unknown',
        'notes',
      ])
    ).toEqual(['notes', 'commits', 'pullRequests', 'git', 'terminal']);
  });
});
