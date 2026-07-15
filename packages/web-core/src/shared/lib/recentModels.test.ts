import { describe, expect, it } from 'vitest';
import { BaseCodingAgent, type ExecutorProfile } from 'shared/types';
import { withRecentReasoning } from './recentModels';

const profiles = {
  [BaseCodingAgent.CODEX]: {
    recently_used_models: {
      models: ['gpt-5.6-sol'],
      reasoning_by_model: { 'gpt-5.6-sol': 'xhigh' },
    },
  } as ExecutorProfile,
};

describe('withRecentReasoning', () => {
  it('materializes the base-model effort for a fast model before discovery', () => {
    expect(
      withRecentReasoning(
        {
          executor: BaseCodingAgent.CODEX,
          variant: 'DEFAULT',
          model_id: 'gpt-5.6-sol-fast',
        },
        profiles
      )
    ).toMatchObject({ reasoning_id: 'xhigh' });
  });

  it('keeps an explicit reasoning override', () => {
    const config = {
      executor: BaseCodingAgent.CODEX,
      variant: 'DEFAULT',
      model_id: 'gpt-5.6-sol-fast',
      reasoning_id: 'high',
    };
    expect(withRecentReasoning(config, profiles)).toBe(config);
  });
});
