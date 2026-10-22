import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { create, useModal } from '@ebay/nice-modal-react';
import { useDropzone } from 'react-dropzone';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ComputerTowerIcon,
  DesktopIcon,
  LightningIcon,
  RobotIcon,
  StarIcon,
} from '@phosphor-icons/react';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { CreateChatBox } from '@vibe/ui/components/CreateChatBox';
import type {
  BaseCodingAgent,
  ExecutorConfig,
  Repo,
  Session,
} from 'shared/types';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { selectWorkspaceSession } from '@/shared/hooks/useWorkspaceSessions';
import { seedOptimisticProcess } from '@/shared/providers/executionProcessScope';
import {
  defineModal,
  getErrorMessage,
  type NoProps,
} from '@/shared/lib/modals';
import { configApi, repoApi, workspacesApi } from '@/shared/lib/api';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { useCreateAttachments } from '@/shared/hooks/useCreateAttachments';
import { toPrettyCase } from '@/shared/lib/string';
import { formatRelativeTime } from '@/shared/lib/date';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { ModelSelectorContainer } from '@/shared/components/ModelSelectorContainer';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { FolderPickerDialog } from '@/shared/dialogs/shared/FolderPickerDialog';
import { useFolderFavoritesStore } from '@/shared/stores/useFolderFavoritesStore';
import { useWorkspaceHostOptions } from '@/shared/hooks/useWorkspaceHostOptions';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { openDestinationInOwnPane } from '@/shared/lib/openInSplitPane';
import {
  REMOTE_SHARED_USER_SYSTEM_QUERY_KEY,
  loadRemoteSharedUserSystemInfo,
} from '@/shared/lib/remoteSharedConfig';

/**
 * "Quick chat": a low-ceremony launcher to run an agent directly in an existing
 * folder. On send it creates an in-place workspace (no `vk/` worktree, no new
 * branch — the agent edits the real working tree) and navigates into the
 * standard workspace conversation view.
 *
 * The "Autopilot" tab reuses the same form to create the host's single
 * always-on watcher workspace (pinned, one session, woken by automation). While
 * one exists the tab shows it instead of the form: open it, or pause (archive)
 * it to start another with a different folder or model.
 *
 * The input reuses the workspace-create card (`CreateChatBox`) for a consistent
 * look: WYSIWYG editor, agent + model selectors, attachments, and the primary
 * send button. The repo-summary slot doubles as the folder picker. Attachments
 * land in the repo's `.vibe-attachments/` (self-ignoring), the same place the
 * agent writes its own images.
 */
const QuickChatDialogImpl = create<NoProps>(() => {
  const modal = useModal();
  const appNavigation = useAppNavigation();
  const { config: routeConfig, profiles: routeProfiles } = useUserSystem();
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
  // Set when a send handed the new workspace to a pane, so the dialog's close
  // focus restore stands down instead of yanking the caret back to its opener.
  const keepPaneFocusRef = useRef(false);

  const selectedHostSystem = useQuery({
    queryKey: ['user-system', 'quick-chat', selectedHostId],
    queryFn: () => configApi.getConfig(selectedHostId),
    enabled: modal.visible && runtime === 'remote' && !!selectedHostId,
    staleTime: 5 * 60 * 1000,
  });
  const remoteSharedSystem = useQuery({
    queryKey: REMOTE_SHARED_USER_SYSTEM_QUERY_KEY,
    queryFn: loadRemoteSharedUserSystemInfo,
    enabled: modal.visible && runtime === 'remote',
    staleTime: 5 * 60 * 1000,
  });
  const config =
    runtime === 'remote'
      ? (selectedHostSystem.data?.config ?? null)
      : routeConfig;
  const profiles =
    runtime === 'remote'
      ? (selectedHostSystem.data?.executors ?? null)
      : routeProfiles;
  const openInNewPane =
    runtime === 'remote'
      ? remoteSharedSystem.data?.config.quick_chat_open_in_new_pane
      : config?.quick_chat_open_in_new_pane;

  const [repo, setRepo] = useState<Repo | null>(null);
  const [prompt, setPrompt] = useState('');
  const [scratchConfig, setScratchConfig] = useState<ExecutorConfig | null>(
    null
  );
  const [submitting, setSubmitting] = useState(false);
  // Stop pressed while the request runs: stop the first turn once it exists.
  const [isStopRequested, setIsStopRequested] = useState(false);
  const stopRequestedRef = useRef(false);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'quick' | 'autopilot'>('quick');
  const isAutopilotMode = mode === 'autopilot';
  // The host's current Autopilot (null = none or paused). Only fetched while
  // the Autopilot tab is open; refetched after a pause so the form appears.
  const autopilotQuery = useQuery({
    queryKey: ['autopilot', selectedHostId],
    queryFn: () => workspacesApi.getAutopilot(selectedHostId),
    enabled: modal.visible && isAutopilotMode,
    staleTime: 10 * 1000,
  });
  const existingAutopilot = isAutopilotMode
    ? (autopilotQuery.data ?? null)
    : null;
  const [pausing, setPausing] = useState(false);

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
    // Quick chat is a global modal with its own host picker, so model discovery
    // must target the selected host rather than the (often absent) page host.
    hostId: selectedHostId,
    onPersist: setScratchConfig,
  });

  // Attachments are uploaded before the workspace exists, then handed to the
  // quick-chat create call as ids; the markdown link is appended to the prompt.
  const handleInsertMarkdown = useCallback((markdown: string) => {
    setPrompt((prev) => (prev.trim() ? `${prev}\n\n${markdown}` : markdown));
  }, []);

  const { uploadFiles, getAttachmentIds, clearAttachments, localAttachments } =
    useCreateAttachments(
      handleInsertMarkdown,
      undefined,
      undefined,
      selectedHostId
    );

  // Drop files anywhere on the chat box, same as the workspace-create box.
  // `noClick`/`noKeyboard`: the paperclip owns those; the zone only handles drops.
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: uploadFiles,
    disabled: submitting || !repo,
    noClick: true,
    noKeyboard: true,
  });

  useEffect(() => {
    const justOpened = modal.visible && !wasVisibleRef.current;
    wasVisibleRef.current = modal.visible;
    if (justOpened) {
      const nextHostId =
        routeHostId ??
        (runtime === 'remote' ? (onlineHosts[0]?.id ?? null) : null);
      setSelectedHostId(nextHostId);
      // The draft survives a dismissal, but it is host-scoped: the repo is
      // registered on the host that owns it and attachment ids live in the host
      // that received the upload, so reopening elsewhere invalidates both.
      if (nextHostId !== selectedHostId) {
        setRepo(null);
        clearAttachments();
      }
    }
  }, [
    modal.visible,
    routeHostId,
    runtime,
    onlineHosts,
    selectedHostId,
    clearAttachments,
  ]);

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
  // leaves `submitting` stuck (Send permanently disabled showing "Starting…").
  // The draft (prompt + its attachments + the folder it targets) and the
  // agent/model selection (`scratchConfig`) are intentionally preserved across
  // reopens; the draft is only cleared by a successful send, by the user
  // emptying the field, or by switching host. Keeping the folder matters: the
  // prompt is usually written *about* it, and silently reverting to the most
  // recent repo would run the agent in the wrong working tree.
  useEffect(() => {
    if (!modal.visible) {
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

  // Route to a workspace and close. Used after a send and by "Open" on the
  // Autopilot card.
  const openWorkspace = useCallback(
    (workspaceId: string) => {
      const goToDocument = () =>
        appNavigation.goToWorkspace(workspaceId, { hostId: selectedHostId });
      // Route the chat before hiding: the dialog's close focus restore fires
      // as soon as the hide flushes, and it has to already know that a pane
      // took focus — otherwise it pulls the caret back to its opener.
      keepPaneFocusRef.current =
        !!openInNewPane &&
        openDestinationInOwnPane(
          { kind: 'workspace', workspaceId, hostId: selectedHostId },
          appNavigation,
          runtime,
          goToDocument
        );
      if (!openInNewPane) goToDocument();
      modal.resolve(workspaceId);
      // Commit the hide together with the pane's (sync) focus: left to the
      // scheduler, WebKit runs the dialog focus guard's deferred reclaim
      // first and pulls focus back out of the pane.
      flushSync(() => modal.hide());
    },
    [appNavigation, selectedHostId, openInNewPane, runtime, modal]
  );

  // Pause = archive: automation skips an archived Autopilot and the tab
  // offers the form again, so a new one can take a different folder or model.
  const pauseAutopilot = useCallback(async () => {
    if (!existingAutopilot) return;
    setPausing(true);
    setError(null);
    try {
      await workspacesApi.update(
        existingAutopilot.workspace.id,
        { archived: true },
        selectedHostId
      );
      await autopilotQuery.refetch();
    } catch (e) {
      setError(getErrorMessage(e) || 'Failed to pause the Autopilot.');
    } finally {
      setPausing(false);
    }
  }, [existingAutopilot, selectedHostId, autopilotQuery]);

  const handleSend = useCallback(async () => {
    if (!repo || !executorConfig || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    stopRequestedRef.current = false;
    setIsStopRequested(false);
    try {
      const { workspace, session, execution_process } =
        await workspacesApi.quickChat(
          {
            repo_id: repo.id,
            executor_config: executorConfig,
            prompt: prompt.trim(),
            name: isAutopilotMode ? 'Autopilot' : null,
            attachment_ids: getAttachmentIds(),
            autopilot: isAutopilotMode,
          },
          selectedHostId
        );
      // Open straight into the new session with its first turn on screen (the
      // agent spawn continues server-side) — see useCreateWorkspace.
      if (session) {
        queryClient.setQueryData<Session[]>(
          workspaceSessionKeys.byWorkspace(workspace.id, selectedHostId),
          [session]
        );
        selectWorkspaceSession(workspace.id, selectedHostId, session.id);
      }
      seedOptimisticProcess(execution_process);
      if (stopRequestedRef.current && session) {
        // Failing that, the turn runs and can be stopped in the chat.
        await workspacesApi
          .stop(workspace.id, selectedHostId, session.id)
          .catch((stopError) =>
            console.error('Failed to stop quick chat', stopError)
          );
      }
      // Sent: the draft is now the workspace's first message, so drop it.
      setPrompt('');
      clearAttachments();
      openWorkspace(workspace.id);
    } catch (e) {
      setError(
        getErrorMessage(e) ||
          (isAutopilotMode
            ? 'Failed to start the Autopilot.'
            : 'Failed to start quick chat.')
      );
      setSubmitting(false);
    }
  }, [
    repo,
    executorConfig,
    prompt,
    isAutopilotMode,
    getAttachmentIds,
    clearAttachments,
    queryClient,
    selectedHostId,
    openWorkspace,
  ]);

  const showForm =
    !isAutopilotMode || (!existingAutopilot && !autopilotQuery.isLoading);

  return (
    <Dialog
      open={modal.visible}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onCloseAutoFocus={(event: Event) => {
        if (!keepPaneFocusRef.current) return;
        keepPaneFocusRef.current = false;
        event.preventDefault();
      }}
      size="xl"
      // KeyboardDialog stacks dialogs at the top (items-start). Quick chat is
      // short, so center it vertically. Inline style overrides the base `my-8`
      // (cn is clsx-only, so a `my-auto` class wouldn't win).
      style={{ marginTop: 'auto', marginBottom: 'auto' }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-base">
          {isAutopilotMode ? (
            <RobotIcon weight="fill" className="size-icon-sm text-brand" />
          ) : (
            <LightningIcon weight="fill" className="size-icon-sm text-brand" />
          )}
          {isAutopilotMode ? 'Autopilot' : 'Quick chat'}
        </DialogTitle>
        <DialogDescription>
          {isAutopilotMode
            ? "An always-on agent for this host: pinned, one session, woken by automation when sessions finish, fail or wait for approval. Its standing rules live in the folder's AGENTS.md."
            : 'Run an agent in an existing folder — no new branch, no isolation. Edits land directly in your working tree.'}
        </DialogDescription>
      </DialogHeader>

      <div
        role="tablist"
        aria-label="Quick chat mode"
        className="inline-flex self-start rounded-md border border-border bg-secondary p-half text-sm"
      >
        {(
          [
            ['quick', 'Quick chat', LightningIcon],
            ['autopilot', 'Autopilot', RobotIcon],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={`inline-flex items-center gap-half rounded px-base py-half ${
              mode === value
                ? 'bg-panel text-high shadow-[inset_0_-2px_0_hsl(var(--brand))]'
                : 'text-low hover:text-normal'
            }`}
          >
            <Icon weight="fill" className="size-icon-xs" />
            {label}
          </button>
        ))}
      </div>

      {isAutopilotMode && autopilotQuery.isLoading && (
        <p className="text-sm text-low">Checking this host's Autopilot…</p>
      )}
      {isAutopilotMode && autopilotQuery.isError && (
        <p className="text-sm text-error">
          {getErrorMessage(autopilotQuery.error) ||
            'Could not check this host for an Autopilot.'}
        </p>
      )}

      {isAutopilotMode && existingAutopilot && (
        <div className="flex flex-col gap-half rounded-md border border-border bg-secondary p-base">
          <div className="flex items-center gap-base">
            <RobotIcon weight="fill" className="size-icon-sm text-brand" />
            <span className="font-medium text-high">
              {existingAutopilot.workspace.name ?? 'Autopilot'}
            </span>
            <span
              className="min-w-0 truncate text-sm text-low"
              title={existingAutopilot.workspace.container_ref ?? ''}
            >
              {existingAutopilot.workspace.container_ref}
            </span>
            <span className="ml-auto shrink-0 text-sm text-low">
              {existingAutopilot.is_running ? 'Running' : 'Idle'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-base text-sm text-low">
            {existingAutopilot.executor_config && (
              <span className="rounded-sm border border-border px-1">
                {toPrettyCase(existingAutopilot.executor_config.executor)}
                {existingAutopilot.executor_config.model_id
                  ? ` · ${existingAutopilot.executor_config.model_id}`
                  : ''}
              </span>
            )}
            {existingAutopilot.workspace.status_updated_at && (
              <span>
                Last summary{' '}
                {formatRelativeTime(
                  existingAutopilot.workspace.status_updated_at
                )}
              </span>
            )}
          </div>
          {existingAutopilot.workspace.status_note && (
            <p className="text-sm text-normal">
              {existingAutopilot.workspace.status_note}
            </p>
          )}
          <div className="flex items-center gap-base pt-half">
            <button
              type="button"
              onClick={() => openWorkspace(existingAutopilot.workspace.id)}
              className="rounded-md bg-brand px-base py-half text-sm font-medium text-on-brand hover:bg-brand-hover"
            >
              Open
            </button>
            <button
              type="button"
              onClick={pauseAutopilot}
              disabled={pausing}
              className="rounded-md border border-border px-base py-half text-sm text-normal hover:text-high disabled:opacity-50"
            >
              {pausing ? 'Pausing…' : 'Pause'}
            </button>
            <button
              type="button"
              onClick={pauseAutopilot}
              disabled={pausing}
              title="Pause this Autopilot and start a new one with a different folder or model"
              className="rounded-md border border-border px-base py-half text-sm text-normal hover:text-high disabled:opacity-50"
            >
              Recreate…
            </button>
            <span className="text-sm text-low">
              One per host. Pausing archives it (the conversation stays in the
              archive).
            </span>
          </div>
          {error && <p className="text-sm text-error">{error}</p>}
        </div>
      )}

      {showForm && (
        <>
          {isAutopilotMode && (
            <p className="text-sm text-low">
              Writes a starter AGENTS.md (its standing rules) into the folder if
              there is none. One Autopilot per host; pause it to change the
              folder or model later.
            </p>
          )}
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
                // Uploaded to the previous host's cache — those ids mean nothing here.
                clearAttachments();
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
              className="inline-flex items-center rounded-md border border-border p-half text-normal hover:text-high disabled:cursor-not-allowed disabled:opacity-50"
            >
              <StarIcon
                weight={isRepoFavorite ? 'fill' : 'regular'}
                className={`size-icon-sm ${isRepoFavorite ? 'text-brand' : ''}`}
              />
            </button>
            {visibleFavorites.map((fav) => {
              const isActive = repo?.path === fav.path;
              return (
                <button
                  type="button"
                  key={fav.path}
                  onClick={() => selectFavorite(fav.path)}
                  title={fav.path}
                  className={`inline-flex items-center gap-half rounded-full border px-base py-half text-sm ${
                    isActive
                      ? 'border-brand text-high'
                      : 'border-border text-normal'
                  } max-w-[200px] truncate hover:text-high`}
                >
                  {fav.name}
                </button>
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
                onPasteFiles,
                localAttachments,
              }) => (
                <WYSIWYGEditor
                  placeholder={
                    isAutopilotMode
                      ? 'First instructions for the Autopilot (its standing rules live in AGENTS.md)…'
                      : 'What can the agent help with?'
                  }
                  value={value}
                  onChange={onChange}
                  onCmdEnter={onCmdEnter}
                  disabled={disabled}
                  className="min-h-double max-h-[40vh] overflow-y-auto"
                  repoIds={repoIds}
                  repoId={repoId}
                  executor={executor}
                  hostId={selectedHostId}
                  onPasteFiles={onPasteFiles}
                  localAttachments={localAttachments}
                  autoFocus
                  // Quick chat always keeps Return available for line breaks. Unlike
                  // regular workspace chat, it only starts an agent on Cmd/Ctrl+Return.
                  sendShortcut="ModifierEnter"
                />
              )}
              agentIcon={
                <AgentIcon
                  agent={effectiveExecutor}
                  className="size-icon-base"
                />
              }
              onSend={handleSend}
              isSending={submitting}
              onStop={() => {
                stopRequestedRef.current = true;
                setIsStopRequested(true);
              }}
              isStopRequested={isStopRequested}
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
                    variant="ghost"
                    agent={effectiveExecutor}
                    workspaceId={undefined}
                    hostId={selectedHostId}
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
              onPasteFiles={uploadFiles}
              localAttachments={localAttachments}
              dropzone={{ getRootProps, getInputProps, isDragActive }}
              sendLabel={isAutopilotMode ? 'Start Autopilot' : 'Send'}
              sendingLabel="Starting…"
            />
          </div>
        </>
      )}
    </Dialog>
  );
});

export const QuickChatDialog = defineModal<void, string | null>(
  QuickChatDialogImpl
);
