import { describe, it, expect } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import {
  applyModelConfigToProfile,
  getModelSelectorProfileFields,
  profileToExecutorConfig,
} from './profileModelConfig';

describe('profileToExecutorConfig', () => {
  it('reads claude model/effort/agent into ExecutorConfig', () => {
    const config = profileToExecutorConfig(
      BaseCodingAgent.CLAUDE_CODE,
      'DEFAULT',
      { model: 'opus', effort: 'high', agent: 'reviewer' }
    );
    expect(config).toEqual({
      executor: BaseCodingAgent.CLAUDE_CODE,
      variant: 'DEFAULT',
      model_id: 'opus',
      reasoning_id: 'high',
      agent_id: 'reviewer',
      permission_policy: null,
    });
  });

  it('maps codex reasoning effort from its executor-specific field', () => {
    const config = profileToExecutorConfig(BaseCodingAgent.CODEX, null, {
      model: 'gpt-5',
      model_reasoning_effort: 'medium',
    });
    expect(config.model_id).toBe('gpt-5');
    expect(config.reasoning_id).toBe('medium');
    expect(config.agent_id).toBeNull();
  });

  it('returns nulls for missing/empty profiles', () => {
    const config = profileToExecutorConfig(
      BaseCodingAgent.GEMINI,
      'DEFAULT',
      {}
    );
    expect(config.model_id).toBeNull();
    expect(config.reasoning_id).toBeNull();
    expect(config.agent_id).toBeNull();
  });
});

describe('applyModelConfigToProfile', () => {
  it('writes model_id into the model field and preserves other keys', () => {
    const next = applyModelConfigToProfile(
      BaseCodingAgent.CLAUDE_CODE,
      { append_prompt: 'keep me', effort: 'high' },
      { model_id: 'sonnet' }
    );
    // model written, unrelated field preserved
    expect(next.model).toBe('sonnet');
    expect(next.append_prompt).toBe('keep me');
    // changing the model clears the stale effort
    expect(next.effort).toBeUndefined();
  });

  it('keeps the effort when model and reasoning change together', () => {
    const next = applyModelConfigToProfile(
      BaseCodingAgent.CLAUDE_CODE,
      { effort: 'low' },
      { model_id: 'opus', reasoning_id: 'max' }
    );
    expect(next.model).toBe('opus');
    expect(next.effort).toBe('max');
  });

  it('writes reasoning_id into the executor-specific field (codex)', () => {
    const next = applyModelConfigToProfile(
      BaseCodingAgent.CODEX,
      {},
      { reasoning_id: 'high' }
    );
    expect(next.model_reasoning_effort).toBe('high');
  });

  it('clears a field when the override is null (default selected)', () => {
    const next = applyModelConfigToProfile(
      BaseCodingAgent.CLAUDE_CODE,
      { model: 'opus', effort: 'high' },
      { model_id: null }
    );
    expect(next.model).toBeUndefined();
    expect(next.effort).toBeUndefined();
  });

  it('ignores reasoning for executors without a reasoning field', () => {
    const next = applyModelConfigToProfile(
      BaseCodingAgent.DROID,
      { model: 'x' },
      { reasoning_id: 'high' }
    );
    // Droid's apply_overrides ignores reasoning_id; we mirror that.
    expect(next).toEqual({ model: 'x' });
  });
});

describe('getModelSelectorProfileFields', () => {
  it('lists model + reasoning + agent fields per executor', () => {
    expect(getModelSelectorProfileFields(BaseCodingAgent.CLAUDE_CODE)).toEqual([
      'model',
      'effort',
      'agent',
    ]);
    expect(getModelSelectorProfileFields(BaseCodingAgent.CODEX)).toEqual([
      'model',
      'model_reasoning_effort',
    ]);
    expect(getModelSelectorProfileFields(BaseCodingAgent.GEMINI)).toEqual([
      'model',
    ]);
  });
});
