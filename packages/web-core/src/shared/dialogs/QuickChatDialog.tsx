import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create, useModal } from '@ebay/nice-modal-react';
import {
  ComputerTowerIcon,
  DesktopIcon,
  LightningIcon,
  StarIcon,
  XIcon,
} from '@phosphor-icons/react';
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
import { useFolderFavoritesStore } from '@/shared/stores/useFolderFavoritesStore';
import { useWorkspaceHostOptions } from '@/shared/hooks/useWorkspaceHostOptions';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useHostId } from '@/shared/providers/HostIdProvider';

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
  const runtime = useAppRuntime();
  const routeHostId = useHostId();
  const { hosts } = useWorkspaceHostOptions();
  const onlineHosts = useMemo(
    () => hosts.filter((host) => host.status === 'online'),
    [hosts]
  );
  const [selectedHostId, setSelectedHostId] = useState<string | null>(
    routeHostId
  );
  const wasVisibleRef = useRef(false);

  const [repo, setRepo] = useState<Repo | null>(null);
  const [prompt, setPrompt] = useState('');
  const [scratchConfig, setScratchConfig] = useState<ExecutorConfig | null>(
    null
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const favorites = useFolderFavoritesStore((s) => s.favorites);
  const addFavorite = useFolderFavoritesStore((s) => s.addFavorite);
  const removeFavorite = useFolderFavoritesStore((s) => s.removeFavorite);
  const visibleFavorites = favorites.filter(
    (favorite) => (favorite.hostId ?? null) === selectedHostId
  );
  const isRepoFavorite = repo
    ? visibleFavorites.some((f) => f.path === repo.path)
    : false;

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

  useEffect(() => {
    const justOpened = modal.visible && !wasVisibleRef.current;
    wasVisibleRef.current = modal.visible;
    if (justOpened) {
      setSelectedHostId(
        routeHostId ??
          (runtime === 'remote' ? (onlineHosts[0]?.id ?? null) : null)
      );
    }
  }, [modal.visible, routeHostId, runtime, onlineHosts]);

  // Pre-fill the folder with the most recently used repo so the common case is
  // a single keystroke (type + send).
  useEffect(() => {
    if (!modal.visible || repo) return;
    let cancelled = false;
    repoApi
      .listRecent(selectedHostId)
      .then((recent) => {
        if (!cancelled && recent[0]) setRepo(recent[0]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modal.visible, repo, selectedHostId]);

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

  // Register a path as a repo and select it. Returns the repo on success so
  // callers (folder picker, favorite chips) can react; sets `error` and returns
  // null when the path isn't a git repository.
  const registerAndSelect = useCallback(
    async (path: string) => {
      try {
        const registered = await repoApi.register({ path }, selectedHostId);
        setRepo(registered);
        return registered;
      } catch (e) {
        setError(
          getErrorMessage(e) ||
            'That folder could not be opened. It must be a git repository.'
        );
        return null;
      }
    },
    [selectedHostId]
  );

  const pickFolder = useCallback(async () => {
    setError(null);
    const path = await FolderPickerDialog.show({
      value: repo?.path,
      title: 'Select a folder',
      description: 'The agent runs directly in this folder.',
      hostId: selectedHostId,
    });
    if (!path) return;
    await registerAndSelect(path);
  }, [repo?.path, registerAndSelect, selectedHostId]);

  const selectFavorite = useCallback(
    async (path: string) => {
      setError(null);
      await registerAndSelect(path);
    },
    [registerAndSelect]
  );

  // Star toggle for the currently selected folder: pin it for one-click reuse,
  // or unpin if already a favorite.
  const toggleFavorite = useCallback(() => {
    if (!repo) return;
    if (isRepoFavorite) {
      removeFavorite(repo.path, selectedHostId);
    } else {
      addFavorite({
        path: repo.path,
        name: repo.display_name || repo.name,
        hostId: selectedHostId,
      });
    }
  }, [repo, isRepoFavorite, addFavorite, removeFavorite, selectedHostId]);

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
      const { workspace } = await workspacesApi.quickChat(
        {
          repo_id: repo.id,
          executor_config: executorConfig,
          prompt: prompt.trim(),
          name: null,
        },
        selectedHostId
      );
      modal.resolve(workspace.id);
      modal.hide();
      appNavigation.goToWorkspace(workspace.id, { hostId: selectedHostId });
    } catch (e) {
      setError(getErrorMessage(e) || 'Failed to start quick chat.');
      setSubmitting(false);
    }
  }, [repo, executorConfig, prompt, modal, appNavigation, selectedHostId]);

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

      <label className="flex items-center gap-base rounded-md border border-border bg-secondary px-base py-half">
        {selectedHostId ? (
          <ComputerTowerIcon className="size-icon-sm shrink-0 text-low" />
        ) : (
          <DesktopIcon className="size-icon-sm shrink-0 text-low" />
        )}
        <span className="text-sm text-low">Run on</span>
        <select
          value={selectedHostId ?? ''}
          onChange={(event) => {
            setSelectedHostId(event.target.value || null);
            setRepo(null);
            setError(null);
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-high outline-none"
          aria-label="Quick chat host"
        >
          {runtime === 'local' && <option value="">This machine</option>}
          {onlineHosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.name}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-base">
        <button
          type="button"
          onClick={toggleFavorite}
          disabled={!repo}
          title={
            isRepoFavorite
              ? 'Remove this folder from favorites'
              : 'Add this folder to favorites'
          }
          aria-label={
            isRepoFavorite
              ? 'Remove this folder from favorites'
              : 'Add this folder to favorites'
          }
          className="inline-flex items-center gap-half rounded-md border border-border px-base py-half text-sm text-normal hover:text-high disabled:cursor-not-allowed disabled:opacity-50"
        >
          <StarIcon
            weight={isRepoFavorite ? 'fill' : 'regular'}
            className={`size-icon-sm ${isRepoFavorite ? 'text-brand' : ''}`}
          />
          {isRepoFavorite ? 'Favorited' : 'Favorite'}
        </button>
        {visibleFavorites.map((fav) => {
          const isActive = repo?.path === fav.path;
          return (
            <span
              key={fav.path}
              className={`inline-flex items-center gap-half rounded-full border px-base py-half text-sm ${
                isActive
                  ? 'border-brand text-high'
                  : 'border-border text-normal'
              }`}
            >
              <button
                type="button"
                onClick={() => selectFavorite(fav.path)}
                title={fav.path}
                className="max-w-[200px] truncate hover:text-high"
              >
                {fav.name}
              </button>
              <button
                type="button"
                onClick={() => removeFavorite(fav.path)}
                aria-label={`Remove ${fav.name} from favorites`}
                title="Remove from favorites"
                className="inline-flex items-center text-low hover:text-error transition-colors"
              >
                <XIcon className="size-icon-xs" weight="bold" />
              </button>
            </span>
          );
        })}
      </div>

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
