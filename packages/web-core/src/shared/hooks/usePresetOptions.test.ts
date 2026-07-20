import { describe, expect, it } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import { presetOptionsKeys } from './usePresetOptions';

describe('presetOptionsKeys', () => {
  it('isolates local and remote host caches for the same profile', () => {
    const local = presetOptionsKeys.byProfile(
      null,
      BaseCodingAgent.CODEX,
      'DEFAULT'
    );
    const pc1 = presetOptionsKeys.byProfile(
      'pc1',
      BaseCodingAgent.CODEX,
      'DEFAULT'
    );
    const i9 = presetOptionsKeys.byProfile(
      'i9',
      BaseCodingAgent.CODEX,
      'DEFAULT'
    );

    expect(local).not.toEqual(pc1);
    expect(pc1).not.toEqual(i9);
    expect(local[1]).toBe('local');
    expect(i9[1]).toBe('i9');
  });
});
