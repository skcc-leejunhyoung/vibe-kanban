import { describe, expect, it } from 'vitest';
import { vibeRunMoved } from './useVibeRunStatus';

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
