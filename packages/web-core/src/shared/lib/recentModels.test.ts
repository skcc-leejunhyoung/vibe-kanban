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

const modelConfig = {
  providers: [],
  models: [
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      provider_id: null,
      reasoning_options: [
        { id: 'high', label: 'High', is_default: true },
        { id: 'xhigh', label: 'Extra high', is_default: false },
      ],
      supports_fast: true,
    },
  ],
  default_model: 'gpt-5.6-sol',
  agents: [],
  permissions: [],
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

  it('uses the discovered default when there is no recent effort', () => {
    expect(
      withRecentReasoning(
        {
          executor: BaseCodingAgent.CODEX,
          variant: 'DEFAULT',
        },
        null,
        modelConfig
      )
    ).toMatchObject({ reasoning_id: 'high' });
  });

  it('ignores a recent effort that discovery no longer supports', () => {
    const staleProfiles = {
      [BaseCodingAgent.CODEX]: {
        recently_used_models: {
          reasoning_by_model: { 'gpt-5.6-sol': 'max' },
        },
      } as ExecutorProfile,
    };
    expect(
      withRecentReasoning(
        {
          executor: BaseCodingAgent.CODEX,
          variant: 'DEFAULT',
          model_id: 'gpt-5.6-sol',
        },
        staleProfiles,
        modelConfig
      )
    ).toMatchObject({ reasoning_id: 'high' });
  });
});
