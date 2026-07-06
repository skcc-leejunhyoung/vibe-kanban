import { describe, expect, it } from 'vitest';
import type { Diff } from 'shared/types';

import {
  initialDiffHoldState,
  selectHeldDiffs,
  type DiffHoldState,
} from './diffStreamHold';

function makeDiff(path: string): Diff {
  return {
    change: 'modified',
    oldPath: path,
    newPath: path,
    oldContent: null,
    newContent: null,
    additions: 1,
    deletions: 0,
    repoId: null,
  };
}

const WS = 'ws-1';

describe('selectHeldDiffs', () => {
  it('serves empty during the first connect (not yet initialized)', () => {
    const { diffs } = selectHeldDiffs(initialDiffHoldState(WS), {
      workspaceId: WS,
      isInitialized: false,
      derived: [],
    });
    expect(diffs).toEqual([]);
  });

  it('serves and remembers the fresh snapshot once initialized', () => {
    const derived = [makeDiff('a'), makeDiff('b')];
    const { diffs, state } = selectHeldDiffs(initialDiffHoldState(WS), {
      workspaceId: WS,
      isInitialized: true,
      derived,
    });
    expect(diffs).toBe(derived);
    expect(state.lastKnown).toBe(derived);
  });

  it('holds the last snapshot by stable reference while reconnecting', () => {
    const derived = [makeDiff('a'), makeDiff('b')];
    // Initialized once...
    const first = selectHeldDiffs(initialDiffHoldState(WS), {
      workspaceId: WS,
      isInitialized: true,
      derived,
    });
    // ...then the socket drops: isInitialized flips false, data rebuilds empty.
    const reconnecting = selectHeldDiffs(first.state, {
      workspaceId: WS,
      isInitialized: false,
      derived: [],
    });
    // Same reference as before — downstream memos must not churn.
    expect(reconnecting.diffs).toBe(derived);
  });

  it('swaps to the new snapshot when the reconnect completes', () => {
    const before = [makeDiff('a')];
    const after = [makeDiff('a'), makeDiff('c')];
    const init = selectHeldDiffs(initialDiffHoldState(WS), {
      workspaceId: WS,
      isInitialized: true,
      derived: before,
    });
    const gap = selectHeldDiffs(init.state, {
      workspaceId: WS,
      isInitialized: false,
      derived: [],
    });
    const restored = selectHeldDiffs(gap.state, {
      workspaceId: WS,
      isInitialized: true,
      derived: after,
    });
    expect(restored.diffs).toBe(after);
  });

  it('drops the cache on workspace switch so old diffs never bleed', () => {
    const derived = [makeDiff('a')];
    const init = selectHeldDiffs(initialDiffHoldState(WS), {
      workspaceId: WS,
      isInitialized: true,
      derived,
    });
    // New workspace, stream not yet initialized: must show empty, not `derived`.
    const switched = selectHeldDiffs(init.state, {
      workspaceId: 'ws-2',
      isInitialized: false,
      derived: [],
    });
    expect(switched.diffs).toEqual([]);
    expect(switched.diffs).not.toBe(derived);
  });

  it('carries workspaceId forward in state', () => {
    const state: DiffHoldState = initialDiffHoldState(WS);
    const { state: next } = selectHeldDiffs(state, {
      workspaceId: 'ws-9',
      isInitialized: false,
      derived: [],
    });
    expect(next.workspaceId).toBe('ws-9');
  });
});
