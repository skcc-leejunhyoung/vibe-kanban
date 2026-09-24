import { describe, expect, it } from 'vitest';
import type { ExecutorConfigs } from 'shared/types';
import { BaseCodingAgent } from 'shared/types';
import {
  canonicalVariantKey,
  getInitialExecutorConfig,
  renameExecutorVariant,
} from './executor';

describe('getInitialExecutorConfig', () => {
  it('prefers DEFAULT when the executor provides it', () => {
    const profiles = {
      [BaseCodingAgent.CODEX]: {
        custom: { CODEX: {} },
        DEFAULT: { CODEX: {} },
      },
    } as unknown as ExecutorConfigs['executors'];

    expect(getInitialExecutorConfig(BaseCodingAgent.CODEX, profiles)).toEqual({
      executor: BaseCodingAgent.CODEX,
      variant: 'DEFAULT',
    });
  });

  it('uses the first configured variant when DEFAULT is absent', () => {
    const profiles = {
      [BaseCodingAgent.CODEX]: {
        zeta: { CODEX: {} },
        alpha: { CODEX: {} },
      },
    } as unknown as ExecutorConfigs['executors'];

    expect(getInitialExecutorConfig(BaseCodingAgent.CODEX, profiles)).toEqual({
      executor: BaseCodingAgent.CODEX,
      variant: 'alpha',
    });
  });

  it('falls back to the executor default when profiles are unavailable', () => {
    expect(getInitialExecutorConfig(BaseCodingAgent.CODEX, null)).toEqual({
      executor: BaseCodingAgent.CODEX,
      variant: null,
    });
  });
});

describe('renameExecutorVariant', () => {
  it('moves the config to the new key without reordering or dropping keys', () => {
    const profile = {
      recently_used_models: { models: [] },
      KIMI_K_3: { CLAUDE_CODE: { model: 'kimi' } },
      DEFAULT: { CLAUDE_CODE: {} },
    };

    const renamed = renameExecutorVariant(profile, 'KIMI_K_3', 'KIMI');

    expect(Object.keys(renamed)).toEqual([
      'recently_used_models',
      'KIMI',
      'DEFAULT',
    ]);
    expect(renamed.KIMI).toBe(profile.KIMI_K_3);
  });
});

describe('canonicalVariantKey', () => {
  it('matches the backend canonical_variant_key', () => {
    // Pairs captured from executors::profile::canonical_variant_key.
    const cases: [string, string][] = [
      ['kimi', 'KIMI'],
      ['kimi-k3', 'KIMI_K_3'],
      ['KIMI_K3', 'KIMI_K_3'],
      ['KIMI_K_3', 'KIMI_K_3'],
      ['GPT6', 'GPT_6'],
      ['kimiK3', 'KIMI_K_3'],
      ['opus45', 'OPUS_45'],
      ['gpt4o', 'GPT_4_O'],
      ['GPT4O', 'GPT_4_O'],
      ['ABCd', 'AB_CD'],
      ['HTTPServer', 'HTTP_SERVER'],
      ['a__b', 'A_B'],
      ['-lead-', 'LEAD'],
      ['my_Config2x', 'MY_CONFIG_2_X'],
      ['Opus4_5Fast', 'OPUS_4_5_FAST'],
      ['default', 'DEFAULT'],
      ['DeFault', 'DEFAULT'],
      ['x9y8', 'X_9_Y_8'],
    ];
    for (const [name, key] of cases) {
      expect(canonicalVariantKey(name), name).toBe(key);
    }
  });
});
