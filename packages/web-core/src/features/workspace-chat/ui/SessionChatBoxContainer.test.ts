import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent, PermissionPolicy } from 'shared/types';
import {
  composerSlashCommandOverrides,
  composerSessionCommand,
  splitComposerSettingsPrompt,
} from '@/shared/lib/composerSlashCommands';
import { buildAgentPrompt } from '@/shared/lib/promptMessage';
import { formatDateShortWithTime } from '@/shared/lib/date';

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
function callback(name: string, provided: Record<string, unknown>) {
  const bindings = { composerSessionCommand, ...provided };
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
          splitComposerSettingsPrompt,
          cancelDebouncedSave: vi.fn(),
          clearDraft,
          setLocalMessage: vi.fn(),
          localMessageRef: { current: command },
          setExecutorOverrides: setOverrides,
          ErrorDialog: { show: vi.fn() },
          t: (key: string) => key,
        };
        const settings = callback('handleComposerCommand', bindings);
        const run = callback(action, {
          ...bindings,
          handleComposerCommand: settings,
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
        expect(setOverrides).toHaveBeenCalledExactlyOnceWith({
          ...bindings.executorConfig,
          ...composerSlashCommandOverrides(command, bindings.executorConfig),
        });
        expect(clearDraft).not.toHaveBeenCalled();
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
    const settings = callback('handleComposerCommand', {
      executorConfig: { executor: BaseCodingAgent.CODEX },
      modelSelectorConfig: null,
      composerSlashCommandOverrides,
      splitComposerSettingsPrompt,
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

  it('retains all existing draft settings when changing only permissions', async () => {
    const executorConfig = {
      executor: BaseCodingAgent.CODEX,
      variant: 'DEFAULT',
      model_id: 'synthetic-draft-model',
      reasoning_id: 'high',
      permission_policy: PermissionPolicy.PLAN,
    };
    const persist = vi.fn();
    const settings = callback('handleComposerCommand', {
      executorConfig,
      modelSelectorConfig: null,
      composerSlashCommandOverrides,
      splitComposerSettingsPrompt,
      cancelDebouncedSave: vi.fn(),
      clearDraft: vi.fn().mockResolvedValue(undefined),
      setLocalMessage: vi.fn(),
      localMessageRef: { current: '/permissions supervised' },
      setExecutorOverrides: persist,
      ErrorDialog: { show: vi.fn() },
      t: (key: string) => key,
    });
    await settings('/permissions supervised');
    expect(persist).toHaveBeenCalledExactlyOnceWith({
      ...executorConfig,
      permission_policy: PermissionPolicy.SUPERVISED,
    });
  });

  it('keeps uploaded attachment references in the next draft when applying settings', async () => {
    const attachment = '![Synthetic diagram](.vibe-attachments/synthetic.png)';
    const command = `/model synthetic-next\n\n${attachment}`;
    const setLocalMessage = vi.fn();
    const persist = vi.fn();
    const settings = callback('handleComposerCommand', {
      executorConfig: { executor: BaseCodingAgent.CODEX },
      modelSelectorConfig: null,
      composerSlashCommandOverrides,
      splitComposerSettingsPrompt,
      cancelDebouncedSave: vi.fn(),
      setLocalMessage,
      localMessageRef: { current: command },
      setExecutorOverrides: persist,
      ErrorDialog: { show: vi.fn() },
      t: (key: string) => key,
    });
    expect(await settings(command)).toBe(true);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ model_id: 'synthetic-next' })
    );
    expect(setLocalMessage).toHaveBeenCalledWith(attachment);
  });
});

describe('Vibe session slash commands', () => {
  function bindings(command: string) {
    return {
      executorConfig: {
        executor: BaseCodingAgent.CODEX,
        model_id: 'synthetic-model',
        reasoning_id: 'high',
      },
      modelSelectorConfig: null,
      composerSlashCommandOverrides,
      splitComposerSettingsPrompt,
      sessionId: 'synthetic-session',
      sessionIdRef: { current: 'synthetic-session' as string | undefined },
      session: { name: 'Synthetic old' },
      workspaceId: 'synthetic-workspace',
      hostId: 'synthetic-host',
      sessionsApi: { update: vi.fn().mockResolvedValue(undefined) },
      queryClient: { invalidateQueries: vi.fn() },
      workspaceSessionKeys: {
        byWorkspace: vi.fn(() => ['synthetic-sessions']),
      },
      handleRenameSession: vi.fn(),
      processes: [],
      entries: [],
      ConfirmDialog: { show: vi.fn() },
      SettingsDialog: { show: vi.fn() },
      ErrorDialog: { show: vi.fn() },
      cancelDebouncedSave: vi.fn(),
      saveToScratch: vi.fn().mockResolvedValue(undefined),
      setLocalMessage: vi.fn(),
      localMessageRef: { current: command },
      setExecutorOverrides: vi.fn(),
      t: (key: string) => key,
    };
  }

  for (const action of ['handleSend', 'handleQueueMessage', 'handleSteer']) {
    it(`${action} renames the Vibe session without queueing or interrupting the agent`, async () => {
      const command = '/rename Synthetic new';
      const setup = bindings(command);
      const handler = callback('handleComposerCommand', setup);
      const dispatch = vi.fn();
      const run = callback(action, {
        ...setup,
        handleComposerCommand: handler,
        localMessage: command,
        reviewMarkdown: '',
        buildAgentPrompt,
        onScrollToBottom: vi.fn(),
        isAttemptRunning: true,
        isCodingAgentRunning: true,
        send: dispatch,
        queueMessage: dispatch,
        steer: dispatch,
        createPendingProcess: dispatch,
      });
      await run();
      expect(setup.sessionsApi.update).toHaveBeenCalledExactlyOnceWith(
        'synthetic-session',
        { name: 'Synthetic new' },
        'synthetic-host'
      );
      expect(setup.workspaceSessionKeys.byWorkspace).toHaveBeenCalledWith(
        'synthetic-workspace',
        'synthetic-host'
      );
      expect(setup.setExecutorOverrides).not.toHaveBeenCalled();
      expect(setup.saveToScratch).toHaveBeenCalledExactlyOnceWith(
        '',
        setup.executorConfig
      );
      expect(dispatch).not.toHaveBeenCalled();
    });
  }

  it('retains the draft and attachments when rename fails', async () => {
    const command =
      '/rename Synthetic new\n\n![Synthetic](.vibe-attachments/synthetic.png)';
    const setup = bindings(command);
    setup.sessionsApi.update.mockRejectedValue(
      new Error('Synthetic rename failure')
    );
    await callback('handleComposerCommand', setup)(command);
    expect(setup.setLocalMessage).not.toHaveBeenCalled();
    expect(setup.localMessageRef.current).toBe(command);
    expect(setup.saveToScratch).not.toHaveBeenCalled();
    expect(setup.ErrorDialog.show).toHaveBeenCalledOnce();
  });

  it('uses the existing rename dialog when no name was supplied', async () => {
    const setup = bindings('/rename');
    await callback('handleComposerCommand', setup)('/rename');
    expect(setup.handleRenameSession).toHaveBeenCalledExactlyOnceWith(
      'synthetic-session',
      'Synthetic old'
    );
    expect(setup.sessionsApi.update).not.toHaveBeenCalled();
  });

  for (const change of ['draft', 'session']) {
    it(`preserves a new ${change} while a rename request completes`, async () => {
      const command = '/rename Synthetic new';
      const setup = bindings(command);
      let complete!: () => void;
      setup.sessionsApi.update.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          })
      );
      const pending = callback('handleComposerCommand', setup)(command);
      if (change === 'draft')
        setup.localMessageRef.current = 'Synthetic next draft';
      else setup.sessionIdRef.current = 'synthetic-other-session';
      complete();
      await pending;
      expect(setup.setLocalMessage).not.toHaveBeenCalled();
      expect(setup.saveToScratch).not.toHaveBeenCalled();
      expect(setup.queryClient.invalidateQueries).toHaveBeenCalledOnce();
    });
  }

  it('opens host-scoped settings even before a session starts', async () => {
    const setup = bindings('/config');
    await callback('handleComposerCommand', { ...setup, sessionId: undefined })(
      '/config'
    );
    expect(setup.SettingsDialog.show).toHaveBeenCalledExactlyOnceWith({
      initialHostId: 'synthetic-host',
    });
  });

  it('replaces consumed session commands in the saved draft while retaining attachments and settings', async () => {
    const attachment = '![Synthetic](.vibe-attachments/synthetic.png)';
    for (const command of [
      '/ps',
      '/warnings',
      '/rename',
      '/config',
      '/config --help',
    ]) {
      const prompt = `${command}\n\n${attachment}`;
      const setup = bindings(prompt);
      let savedMessage = prompt;
      setup.saveToScratch.mockImplementation(async (message: string) => {
        savedMessage = message;
      });
      await callback('handleComposerCommand', setup)(prompt);
      expect(savedMessage).toBe(attachment);
      expect(setup.saveToScratch).toHaveBeenCalledExactlyOnceWith(
        attachment,
        setup.executorConfig
      );
      expect(setup.setLocalMessage).toHaveBeenCalledWith(attachment);
      expect(setup.ErrorDialog.show).not.toHaveBeenCalled();
    }
  });

  it('lists only current visible session executions and warnings', async () => {
    const setup = bindings('/ps');
    const processes = [
      {
        id: 'synthetic-current',
        session_id: setup.sessionId,
        run_reason: 'codingagent',
        status: 'running',
        dropped: false,
        started_at: '2024-01-01T00:00:00Z',
      },
      {
        id: 'synthetic-other',
        session_id: 'synthetic-other-session',
        run_reason: 'devserver',
        status: 'running',
        dropped: false,
      },
      {
        id: 'synthetic-dropped',
        session_id: setup.sessionId,
        run_reason: 'cleanupscript',
        status: 'running',
        dropped: true,
      },
    ];
    const entry = (id: string, content: string, type = 'error_message') => ({
      executionProcessId: id,
      type: 'NORMALIZED_ENTRY',
      content: { entry_type: { type }, content },
    });
    const entries = [
      entry('synthetic-current', 'Synthetic visible warning'),
      entry(
        'synthetic-current',
        'warning: model rerouted from synthetic-a to synthetic-b',
        'system_message'
      ),
      entry('synthetic-current', 'Synthetic ordinary status', 'system_message'),
      entry('synthetic-other', 'Synthetic foreign warning'),
      entry('synthetic-dropped', 'Synthetic dropped warning'),
    ];
    const handler = callback('handleComposerCommand', {
      ...setup,
      processes,
      entries,
      formatDateShortWithTime,
    });
    await handler('/ps');
    const message = setup.ConfirmDialog.show.mock.calls[0][0].message;
    // KST-pinned regardless of the runner's zone.
    expect(message).toContain(
      `Agent — ${formatDateShortWithTime('2024-01-01T00:00:00Z')}`
    );
    expect(message).toContain('09:00');
    expect(message).not.toContain('Dev server');
    expect(message).not.toContain('Cleanup');
    await handler('/warnings');
    expect(setup.ConfirmDialog.show.mock.calls[1][0].message).toBe(
      'Synthetic visible warning\n\nwarning: model rerouted from synthetic-a to synthetic-b'
    );
  });
});
