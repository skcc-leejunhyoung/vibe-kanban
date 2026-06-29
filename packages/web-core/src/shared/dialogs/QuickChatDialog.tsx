import { useCallback, useEffect, useState } from 'react';
import { create, useModal } from '@ebay/nice-modal-react';
import { LightningIcon } from '@phosphor-icons/react';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { CreateChatBox } from '@vibe/ui/components/CreateChatBox';
import type { BaseCodingAgent, ExecutorConfig, Repo } from 'shared/types';
import {
  defineModal,
  getErrorMessage,
  type NoProps,
} from '@/shared/lib/modals';
import { repoApi, workspacesApi } from '@/shared/lib/api';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { toPrettyCase } from '@/shared/lib/string';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { ModelSelectorContainer } from '@/shared/components/ModelSelectorContainer';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { FolderPickerDialog } from '@/shared/dialogs/shared/FolderPickerDialog';

/**
 * "Quick chat": a low-ceremony launcher to run an agent directly in an existing
 * folder. On send it creates an in-place workspace (no `vk/` worktree, no new
 * branch — the agent edits the real working tree) and navigates into the
 * standard workspace conversation view.
 *
 * The input reuses the workspace-create card (`CreateChatBox`) for a consistent
 * look: WYSIWYG editor, agent + model selectors, and the primary send button.
 * The repo-summary slot doubles as the folder picker; attachments are hidden
 * (in-place has no isolated tree to stage them in).
 */
const QuickChatDialogImpl = create<NoProps>(() => {
  const modal = useModal();
  const appNavigation = useAppNavigation();
  const { config, profiles } = useUserSystem();

  const [repo, setRepo] = useState<Repo | null>(null);
  const [prompt, setPrompt] = useState('');
  const [scratchConfig, setScratchConfig] = useState<ExecutorConfig | null>(
    null
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    executorConfig,
    effectiveExecutor,
    selectedVariant,
    executorOptions,
    variantOptions,
    presetOptions,
    setOverrides,
  } = useExecutorConfig({
    profiles,
    lastUsedConfig: config?.executor_profile ?? null,
    scratchConfig,
    configExecutorProfile: config?.executor_profile,
    disabledExecutors: config?.disabled_executors,
    onPersist: setScratchConfig,
  });

  // Pre-fill the folder with the most recently used repo so the common case is
  // a single keystroke (type + send).
  useEffect(() => {
    if (!modal.visible || repo) return;
    let cancelled = false;
    repoApi
      .listRecent()
      .then((recent) => {
        if (!cancelled && recent[0]) setRepo(recent[0]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modal.visible, repo]);

  // nice-modal keeps this component mounted under the app layout, so React
  // state survives `hide()` and the post-send SPA navigation. Reset transient
  // state on dismissal so a reopen starts clean — otherwise a successful send
  // leaves `submitting` stuck (Send permanently disabled showing "Starting…")
  // and the previous prompt pre-filled. The agent/model selection
  // (`scratchConfig`) is intentionally preserved across reopens.
  useEffect(() => {
    if (!modal.visible) {
      setRepo(null);
      setPrompt('');
      setSubmitting(false);
      setError(null);
    }
  }, [modal.visible]);

  const close = () => {
    modal.resolve(null);
    modal.hide();
  };

  const pickFolder = useCallback(async () => {
    setError(null);
    const path = await FolderPickerDialog.show({
      value: repo?.path,
      title: 'Select a folder',
      description: 'The agent runs directly in this folder.',
    });
    if (!path) return;
    try {
      const registered = await repoApi.register({ path });
      setRepo(registered);
    } catch (e) {
      setError(
        getErrorMessage(e) ||
          'That folder could not be opened. It must be a git repository.'
      );
    }
  }, [repo?.path]);

  const handleExecutorChange = useCallback((executor: BaseCodingAgent) => {
    setScratchConfig(
      (prev) => ({ ...(prev ?? {}), executor, variant: null }) as ExecutorConfig
    );
  }, []);

  const handlePresetSelect = useCallback(
    (presetId: string | null) => {
      if (!effectiveExecutor) return;
      setScratchConfig(
        (prev) =>
          ({
            ...(prev ?? {}),
            executor: effectiveExecutor,
            variant: presetId,
          }) as ExecutorConfig
      );
    },
    [effectiveExecutor]
  );

  const handleCustomise = useCallback(() => {
    SettingsDialog.show({ initialSection: 'agents' });
  }, []);

  const handleSend = useCallback(async () => {
    if (!repo || !executorConfig || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { workspace } = await workspacesApi.quickChat({
        repo_id: repo.id,
        executor_config: executorConfig,
        prompt: prompt.trim(),
        name: null,
      });
      modal.resolve(workspace.id);
      modal.hide();
      appNavigation.goToWorkspace(workspace.id);
    } catch (e) {
      setError(getErrorMessage(e) || 'Failed to start quick chat.');
      setSubmitting(false);
    }
  }, [repo, executorConfig, prompt, modal, appNavigation]);

  return (
    <Dialog
      open={modal.visible}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      className="max-w-xl"
      // KeyboardDialog stacks dialogs at the top (items-start). Quick chat is
      // short, so center it vertically. Inline style overrides the base `my-8`
      // (cn is clsx-only, so a `my-auto` class wouldn't win).
      style={{ marginTop: 'auto', marginBottom: 'auto' }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-base">
          <LightningIcon weight="fill" className="size-icon-sm text-brand" />
          Quick chat
        </DialogTitle>
        <DialogDescription>
          Run an agent in an existing folder — no new branch, no isolation.
          Edits land directly in your working tree.
        </DialogDescription>
      </DialogHeader>

      <div className="@container">
        <CreateChatBox
          editor={{ value: prompt, onChange: setPrompt }}
          renderEditor={({
            value,
            onChange,
            onCmdEnter,
            disabled,
            repoIds,
            repoId,
            executor,
          }) => (
            <WYSIWYGEditor
              placeholder="What can the agent help with?"
              value={value}
              onChange={onChange}
              onCmdEnter={onCmdEnter}
              disabled={disabled}
              className="min-h-double max-h-[40vh] overflow-y-auto"
              repoIds={repoIds}
              repoId={repoId}
              executor={executor}
              autoFocus
              sendShortcut={config?.send_message_shortcut}
            />
          )}
          agentIcon={
            <AgentIcon agent={effectiveExecutor} className="size-icon-xl" />
          }
          onSend={handleSend}
          isSending={submitting}
          disabled={!repo || !effectiveExecutor}
          executor={{
            selected: effectiveExecutor,
            options: executorOptions,
            onChange: handleExecutorChange,
          }}
          formatExecutorLabel={toPrettyCase}
          error={error}
          repoId={repo?.id}
          repoIds={repo ? [repo.id] : []}
          modelSelector={
            effectiveExecutor ? (
              <ModelSelectorContainer
                agent={effectiveExecutor}
                workspaceId={undefined}
                onAdvancedSettings={handleCustomise}
                presets={variantOptions}
                selectedPreset={selectedVariant}
                onPresetSelect={handlePresetSelect}
                onOverrideChange={setOverrides}
                executorConfig={executorConfig}
                presetOptions={presetOptions}
              />
            ) : undefined
          }
          onEditRepos={pickFolder}
          repoSummaryLabel={
            repo ? repo.display_name || repo.name : 'Select a folder…'
          }
          repoSummaryTitle={repo?.path ?? 'Select a folder'}
          showAttachments={false}
          sendLabel="Send"
          sendingLabel="Starting…"
        />
      </div>
    </Dialog>
  );
});

export const QuickChatDialog = defineModal<void, string | null>(
  QuickChatDialogImpl
);
