import { describe, expect, it } from 'vitest';
import {
  BaseCodingAgent,
  PermissionPolicy,
  type ExecutorConfig,
} from 'shared/types';
import { composerSlashCommandOverrides } from './composerSlashCommands';

describe('composer slash command settings', () => {
  const codex: ExecutorConfig = { executor: BaseCodingAgent.CODEX };

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
