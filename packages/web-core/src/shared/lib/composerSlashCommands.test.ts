import { describe, expect, it } from 'vitest';
import {
  BaseCodingAgent,
  PermissionPolicy,
  type ExecutorConfig,
  type ModelSelectorConfig,
} from 'shared/types';
import { composerSlashCommandOverrides } from './composerSlashCommands';

describe('composer slash command settings', () => {
  const codex: ExecutorConfig = { executor: BaseCodingAgent.CODEX };
  const models: ModelSelectorConfig = {
    providers: [],
    agents: [],
    permissions: [],
    default_model: 'synthetic-model',
    models: [
      {
        id: 'synthetic-model',
        name: 'Synthetic',
        provider_id: null,
        supports_fast: true,
        reasoning_options: [],
      },
    ],
  };

  it('persists Fast toggles without losing reasoning or a provider prefix', () => {
    const selected = {
      ...codex,
      model_id: 'synthetic-model-fast',
      reasoning_id: 'high',
    };
    for (const command of ['/fast off', '/fast']) {
      expect(composerSlashCommandOverrides(command, selected, models)).toEqual({
        model_id: 'synthetic-model',
        reasoning_id: 'high',
      });
    }
    expect(composerSlashCommandOverrides('/fast on', codex, models)).toEqual({
      model_id: 'synthetic-model-fast',
      reasoning_id: null,
    });
    const scoped = {
      ...models,
      providers: [{ id: 'synthetic-provider', name: 'Synthetic' }],
      models: models.models.map((m) => ({
        ...m,
        provider_id: 'synthetic-provider',
      })),
    };
    expect(
      composerSlashCommandOverrides(
        '/fast off',
        { ...selected, model_id: 'synthetic-provider/synthetic-model-fast' },
        scoped
      )
    ).toEqual({
      model_id: 'synthetic-provider/synthetic-model',
      reasoning_id: 'high',
    });
    expect(
      composerSlashCommandOverrides('/fast status', selected, models)
    ).toBeNull();
    expect(
      composerSlashCommandOverrides(
        '/fast off',
        { ...selected, model_id: 'SYNTHETIC-MODEL-fast' },
        models
      )
    ).toEqual({ model_id: 'SYNTHETIC-MODEL', reasoning_id: 'high' });
  });

  it('validates fast arguments and model capabilities before dispatch', () => {
    expect(() =>
      composerSlashCommandOverrides('/fast invalid', codex, models)
    ).toThrow('Usage:');
    expect(() => composerSlashCommandOverrides('/fast on', codex)).toThrow(
      'Wait for'
    );
    expect(() =>
      composerSlashCommandOverrides(
        '/fast on',
        { ...codex, model_id: 'custom-fast' },
        models
      )
    ).toThrow('Select a model');
  });

  it('updates the same fields as the model selector and clears stale reasoning', () => {
    expect(
      composerSlashCommandOverrides(' /model provider/test-model ', codex)
    ).toEqual({ model_id: 'provider/test-model', reasoning_id: null });
    expect(composerSlashCommandOverrides('/reasoning ultra', codex)).toEqual({
      reasoning_id: 'ultra',
    });
  });

  it('toggles plan without silently enabling automatic approvals when leaving it', () => {
    expect(composerSlashCommandOverrides('/plan', codex)).toEqual({
      permission_policy: PermissionPolicy.PLAN,
    });
    expect(
      composerSlashCommandOverrides('/plan', {
        ...codex,
        permission_policy: PermissionPolicy.PLAN,
      })
    ).toEqual({ permission_policy: PermissionPolicy.SUPERVISED });
    expect(composerSlashCommandOverrides('/plan off', codex)).toEqual({
      permission_policy: PermissionPolicy.SUPERVISED,
    });
  });

  it('sets explicit permission choices and supports Claude Code', () => {
    const claude = { executor: BaseCodingAgent.CLAUDE_CODE };
    expect(
      composerSlashCommandOverrides('/approvals dont_ask', claude)
    ).toEqual({ permission_policy: PermissionPolicy.DONT_ASK });
    expect(composerSlashCommandOverrides('/model test-model', claude)).toEqual({
      model_id: 'test-model',
      reasoning_id: null,
    });
    expect(
      composerSlashCommandOverrides('/reasoning ultracode', claude)
    ).toEqual({ reasoning_id: 'ultracode' });
  });

  it('keeps queries, planning requests, custom commands and other agents on the executor path', () => {
    for (const prompt of [
      '/model',
      '/permissions',
      '/plan inspect the parser',
      '/custom value',
      'hello',
      '/model foo\nadditional instructions',
    ]) {
      expect(composerSlashCommandOverrides(prompt, codex)).toBeNull();
    }
    expect(
      composerSlashCommandOverrides('/model foo', {
        executor: BaseCodingAgent.OPENCODE,
      })
    ).toBeNull();
  });

  it('rejects invalid settings before dispatch', () => {
    for (const prompt of [
      '/model a b',
      '/reasoning unknown',
      '/permissions never',
    ]) {
      expect(() => composerSlashCommandOverrides(prompt, codex)).toThrow(
        'Usage:'
      );
    }
    expect(() =>
      composerSlashCommandOverrides('/reasoning ultra', {
        executor: BaseCodingAgent.CLAUDE_CODE,
      })
    ).toThrow('Usage:');
  });
});
