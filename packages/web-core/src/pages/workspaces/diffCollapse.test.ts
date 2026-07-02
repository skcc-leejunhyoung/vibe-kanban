import { describe, expect, it } from 'vitest';
import type { Diff, DiffChangeKind } from 'shared/types';

import { COLLAPSE_MAX_LINES, shouldAutoCollapse } from './diffCollapse';

function makeDiff(
  change: DiffChangeKind,
  additions: number,
  deletions: number
): Diff {
  return {
    change,
    oldPath: 'a',
    newPath: 'a',
    oldContent: null,
    newContent: null,
    additions,
    deletions,
    repoId: null,
  };
}

describe('shouldAutoCollapse', () => {
  it('keeps small added/modified files expanded', () => {
    expect(shouldAutoCollapse(makeDiff('added', 10, 0))).toBe(false);
    expect(shouldAutoCollapse(makeDiff('modified', 50, 30))).toBe(false);
  });

  it('collapses low-signal change kinds regardless of size', () => {
    expect(shouldAutoCollapse(makeDiff('deleted', 5, 5))).toBe(true);
    expect(shouldAutoCollapse(makeDiff('copied', 5, 5))).toBe(true);
    expect(shouldAutoCollapse(makeDiff('permissionChange', 0, 0))).toBe(true);
  });

  it('collapses files above the line threshold (the perf guard)', () => {
    expect(
      shouldAutoCollapse(makeDiff('modified', COLLAPSE_MAX_LINES, 0))
    ).toBe(false);
    expect(
      shouldAutoCollapse(makeDiff('modified', COLLAPSE_MAX_LINES + 1, 0))
    ).toBe(true);
    expect(shouldAutoCollapse(makeDiff('added', 5000, 0))).toBe(true);
  });

  it('collapses a pure rename but expands a rename with real edits', () => {
    expect(shouldAutoCollapse(makeDiff('renamed', 0, 0))).toBe(true);
    expect(shouldAutoCollapse(makeDiff('renamed', 20, 10))).toBe(false);
    expect(
      shouldAutoCollapse(makeDiff('renamed', COLLAPSE_MAX_LINES + 1, 0))
    ).toBe(true);
  });

  it('treats null additions/deletions as zero', () => {
    const diff = {
      ...makeDiff('modified', 0, 0),
      additions: null,
      deletions: null,
    };
    expect(shouldAutoCollapse(diff)).toBe(false);
  });
});
