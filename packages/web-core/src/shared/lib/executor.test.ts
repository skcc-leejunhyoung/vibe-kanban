import { describe, expect, it } from 'vitest';
import type { ExecutorConfigs } from 'shared/types';
import { BaseCodingAgent } from 'shared/types';
import { getInitialExecutorConfig } from './executor';

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
