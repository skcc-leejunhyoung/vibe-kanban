import { describe, it, expect } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import {
  getReasoningOverride,
  splitFastSuffix,
  normalizeFastModelId,
  FAST_SUFFIX,
} from './modelSelector';

const FAST_CAPABLE = new Set(['gpt-5.5', 'gpt-5.4', 'gpt-5.6-luna']);
const supportsFast = (baseId: string) => FAST_CAPABLE.has(baseId.toLowerCase());

describe('getReasoningOverride', () => {
  const executorConfig = {
    executor: BaseCodingAgent.CODEX,
    variant: 'DEFAULT',
    model_id: 'gpt-5.6-sol-fast',
  };

  it('materializes a picker fallback missing from executor config', () => {
    expect(getReasoningOverride(executorConfig, 'xhigh')).toEqual({
      reasoning_id: 'xhigh',
    });
  });

  it('does not update an already aligned executor config', () => {
    expect(
      getReasoningOverride(
        { ...executorConfig, reasoning_id: 'xhigh' },
        'xhigh'
      )
    ).toBeNull();
  });
});

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

describe('normalizeFastModelId', () => {
  it('strips a fast suffix from a bare preset/default model id', () => {
    // Regression: a preset stored as `gpt-5.5-fast` must resolve to the real
    // base model, not a phantom `gpt-5.5-fast` entry with no reasoning options.
    expect(normalizeFastModelId('gpt-5.5-fast', false, supportsFast)).toEqual({
      modelId: 'gpt-5.5',
      fast: true,
    });
  });

  it('strips the suffix while preserving the provider prefix', () => {
    expect(
      normalizeFastModelId('openai/gpt-5.5-fast', true, supportsFast)
    ).toEqual({ modelId: 'openai/gpt-5.5', fast: true });
  });

  it('leaves a non-fast model id untouched', () => {
    expect(normalizeFastModelId('gpt-5.5', false, supportsFast)).toEqual({
      modelId: 'gpt-5.5',
      fast: false,
    });
    expect(normalizeFastModelId('openai/gpt-5.5', true, supportsFast)).toEqual({
      modelId: 'openai/gpt-5.5',
      fast: false,
    });
  });

  it('does not strip when the base is not fast-capable', () => {
    expect(
      normalizeFastModelId('gpt-5.2-codex-fast', false, supportsFast)
    ).toEqual({ modelId: 'gpt-5.2-codex-fast', fast: false });
  });

  it('passes null / undefined through', () => {
    expect(normalizeFastModelId(null, false, supportsFast)).toEqual({
      modelId: null,
      fast: false,
    });
    expect(normalizeFastModelId(undefined, true, supportsFast)).toEqual({
      modelId: null,
      fast: false,
    });
  });
});
