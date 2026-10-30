import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import { composerSlashCommandOverrides } from '@/shared/lib/composerSlashCommands';
import { buildAgentPrompt } from '@/shared/lib/promptMessage';

// Exercise the real action callbacks without mounting unrelated workspace providers.
const source = ts.createSourceFile(
  'SessionChatBoxContainer.tsx',
  readFileSync(
    new URL('./SessionChatBoxContainer.tsx', import.meta.url),
    'utf8'
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
function callback(name: string, bindings: Record<string, unknown>) {
  let expression = '';
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      expression = node.initializer.arguments[0].getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(expression).not.toBe('');
  const js = ts.transpileModule(`const action = ${expression};`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  return new Function(...Object.keys(bindings), `${js}; return action;`)(
    ...Object.values(bindings)
  );
}

describe('composer settings through every send action', () => {
  for (const action of ['handleSend', 'handleQueueMessage', 'handleSteer']) {
    for (const command of [
      '/model synthetic-next',
      '/reasoning low',
      '/permissions supervised',
    ]) {
      it(`${action} applies ${command} without sending or interrupting`, async () => {
        const setOverrides = vi.fn();
        const clearAttachments = vi.fn();
        const clearComments = vi.fn();
        const dispatch = vi.fn();
        const clearDraft = vi.fn().mockResolvedValue(undefined);
        const bindings = {
          executorConfig: { executor: BaseCodingAgent.CODEX },
          modelSelectorConfig: null,
          composerSlashCommandOverrides,
          cancelDebouncedSave: vi.fn(),
          clearDraft,
          setLocalMessage: vi.fn(),
          localMessageRef: { current: command },
          setExecutorOverrides: setOverrides,
          ErrorDialog: { show: vi.fn() },
          t: (key: string) => key,
        };
        const settings = callback('handleSettingsCommand', bindings);
        const run = callback(action, {
          ...bindings,
          handleSettingsCommand: settings,
          localMessage: command,
          reviewMarkdown: 'Retain these comments',
          buildAgentPrompt,
          onScrollToBottom: vi.fn(),
          isAttemptRunning: true,
          isCodingAgentRunning: true,
          sessionId: 'synthetic-session',
          workspaceId: 'synthetic-workspace',
          clearUploadedAttachments: clearAttachments,
          reviewContext: { clearComments },
          send: dispatch,
          queueMessage: dispatch,
          steer: dispatch,
          createPendingProcess: dispatch,
        });
        await run();
        expect(setOverrides).toHaveBeenCalledExactlyOnceWith(
          composerSlashCommandOverrides(command, bindings.executorConfig)
        );
        expect(clearDraft).toHaveBeenCalledOnce();
        expect(dispatch).not.toHaveBeenCalled();
        expect(clearAttachments).not.toHaveBeenCalled();
        expect(clearComments).not.toHaveBeenCalled();
      });
    }
  }

  it('keeps invalid settings in the composer and shows the error', async () => {
    const overrides = vi.fn();
    const clearDraft = vi.fn();
    const dialog = vi.fn();
    const settings = callback('handleSettingsCommand', {
      executorConfig: { executor: BaseCodingAgent.CODEX },
      modelSelectorConfig: null,
      composerSlashCommandOverrides,
      setExecutorOverrides: overrides,
      clearDraft,
      ErrorDialog: { show: dialog },
      t: (key: string) => key,
    });
    expect(await settings('/reasoning invalid')).toBe(true);
    expect(dialog).toHaveBeenCalledOnce();
    expect(clearDraft).not.toHaveBeenCalled();
    expect(overrides).not.toHaveBeenCalled();
    expect(await settings('ordinary prompt')).toBe(false);
  });
});
