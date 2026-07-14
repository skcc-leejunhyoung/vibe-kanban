import { describe, it, expect } from 'vitest';
import { splitFastSuffix, FAST_SUFFIX } from './modelSelector';

const FAST_CAPABLE = new Set(['gpt-5.5', 'gpt-5.4', 'gpt-5.6-luna']);
const supportsFast = (baseId: string) => FAST_CAPABLE.has(baseId.toLowerCase());

describe('splitFastSuffix', () => {
  it('strips the suffix and flags fast when the base supports it', () => {
    expect(splitFastSuffix('gpt-5.5-fast', supportsFast)).toEqual({
      baseId: 'gpt-5.5',
      fast: true,
    });
    expect(splitFastSuffix('gpt-5.6-luna-fast', supportsFast)).toEqual({
      baseId: 'gpt-5.6-luna',
      fast: true,
    });
  });

  it('leaves non-fast ids untouched', () => {
    expect(splitFastSuffix('gpt-5.5', supportsFast)).toEqual({
      baseId: 'gpt-5.5',
      fast: false,
    });
  });

  it('does not treat a -fast suffix as fast when the base is unknown', () => {
    // Base "gpt-5.2-codex" is not fast-capable, so the id passes through.
    expect(splitFastSuffix('gpt-5.2-codex-fast', supportsFast)).toEqual({
      baseId: 'gpt-5.2-codex-fast',
      fast: false,
    });
  });

  it('handles null / undefined', () => {
    expect(splitFastSuffix(null, supportsFast)).toEqual({
      baseId: null,
      fast: false,
    });
    expect(splitFastSuffix(undefined, supportsFast)).toEqual({
      baseId: null,
      fast: false,
    });
  });

  it('exposes the suffix constant', () => {
    expect(FAST_SUFFIX).toBe('-fast');
  });
});
