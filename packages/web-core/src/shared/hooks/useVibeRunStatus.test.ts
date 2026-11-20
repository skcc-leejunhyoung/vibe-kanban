import { describe, expect, it } from 'vitest';
import { vibeRunMoved, vibeRunPollMs } from './useVibeRunStatus';

const at = (phase: string | null | undefined, workspaceId = 'workspace-1') => ({
  workspaceId,
  phase,
});

describe('vibeRunMoved', () => {
  it('sees each step the server takes after the review', () => {
    expect(vibeRunMoved(at('review'), at('merging'))).toBe(true);
    expect(vibeRunMoved(at('merging'), at('pushing'))).toBe(true);
    expect(vibeRunMoved(at('pushing'), at('creating_pr'))).toBe(true);
    expect(vibeRunMoved(at('creating_pr'), at('done'))).toBe(true);
    expect(vibeRunMoved(at('pushing'), at('blocked'))).toBe(true);
    // A workspace's first run appearing is a move too.
    expect(vibeRunMoved(at(null), at('review'))).toBe(true);
  });

  it('does not take the first read or a repeated read for a move', () => {
    expect(vibeRunMoved(at(undefined), at('done'))).toBe(false);
    expect(vibeRunMoved(at('done'), at(undefined))).toBe(false);
    expect(vibeRunMoved(at('creating_pr'), at('creating_pr'))).toBe(false);
    expect(vibeRunMoved(at(null), at(null))).toBe(false);
  });

  it('does not compare the runs of two workspaces', () => {
    expect(
      vibeRunMoved(at('done', 'workspace-1'), at('review', 'workspace-2'))
    ).toBe(false);
    expect(vibeRunMoved(at('done', ''), at('review', ''))).toBe(false);
  });
});

describe('vibeRunPollMs', () => {
  const at = (
    phase: string | null,
    last_error: string | null = null,
    pending_kind: string | null = null
  ) => ({
    phase,
    last_error,
    pending_kind,
  });

  // The worker may be down for long: no faster than a review.
  it('reads a run waiting for the automation worker every few seconds', () => {
    for (const phase of ['review', 'done', 'coding']) {
      expect(vibeRunPollMs(at(phase, null, 'vibe.turn_ended'))).toBe(15_000);
    }
  });

  it('reads the steps the server takes by itself every few seconds', () => {
    for (const phase of ['merging', 'pushing', 'creating_pr']) {
      expect(vibeRunPollMs(at(phase))).toBe(3_000);
    }
  });

  // A merge waiting on a dirty base stays `merging` for up to hours; every
  // open composer would otherwise ask every three seconds, over the relay too.
  it('slows down for a merge held up by a failure', () => {
    expect(
      vibeRunPollMs(at('merging', "repo: 'main' has uncommitted changes"))
    ).toBe(15_000);
  });

  it('reads a review now and then and anything else once a minute', () => {
    expect(vibeRunPollMs(at('review'))).toBe(15_000);
    for (const phase of ['coding', 'blocked', 'done', null]) {
      expect(vibeRunPollMs(at(phase))).toBe(60_000);
    }
    expect(vibeRunPollMs(undefined)).toBe(60_000);
  });
});
