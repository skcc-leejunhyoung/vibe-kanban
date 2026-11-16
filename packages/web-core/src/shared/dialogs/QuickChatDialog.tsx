import { BaseCodingAgent } from 'shared/types';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
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
  TrayIcon,
} from '@phosphor-icons/react';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { CreateChatBox } from '@vibe/ui/components/CreateChatBox';
import { isPlainEscape } from '@vibe/ui/lib/dialog-keyboard';
import type { ExecutorConfig, Repo, Session } from 'shared/types';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { selectWorkspaceSession } from '@/shared/hooks/useWorkspaceSessions';
import { seedOptimisticProcess } from '@/shared/providers/executionProcessScope';
import { defineModal, getErrorMessage } from '@/shared/lib/modals';
import { repoApi, workspacesApi } from '@/shared/lib/api';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useAppUserSystem } from '@/shared/hooks/useAppUserSystem';
import { HostUserSystemScope } from '@/shared/providers/HostUserSystemScope';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { useCreateAttachments } from '@/shared/hooks/useCreateAttachments';
import { toPrettyCase } from '@/shared/lib/string';
import { formatRelativeTime } from '@/shared/lib/date';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { ChatUsageIndicator } from '@/shared/components/ChatUsageIndicator';
import { ModelSelectorContainer } from '@/shared/components/ModelSelectorContainer';
import { PaneWidthProvider } from '@/shared/components/workspace-panes/PaneWidthContext';
import {
  NEXT_SPLIT_PANE_BINDING_ID,
  PREVIOUS_SPLIT_PANE_BINDING_ID,
  matchesCombo,
  resolveModifier,
} from '@/shared/keyboard/registry';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { FolderPickerDialog } from '@/shared/dialogs/shared/FolderPickerDialog';
import { DrawerTab } from '@/shared/dialogs/quick-chat/DrawerTab';
import { useDrawerNotes } from '@/shared/hooks/useDrawer';
import { useFolderFavoritesStore } from '@/shared/stores/useFolderFavoritesStore';
import { useWorkspaceHostOptions } from '@/shared/hooks/useWorkspaceHostOptions';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { openDestinationInOwnPane } from '@/shared/lib/openInSplitPane';
import {
  buildQuickChatHostOptions,
  canOfferAutopilotForm,
  describeUnavailableQuickChatHost,
} from '@/shared/dialogs/quick-chat/hostOptions';
import { useQuickChatHostSelection } from '@/shared/dialogs/quick-chat/useQuickChatHostSelection';
import {
  useQuickChatHostDraft,
  type QuickChatHostDraft,
  type QuickChatHostDraftPatch,
} from '@/shared/dialogs/quick-chat/useQuickChatHostDraft';
import { QuickChatHostSelect } from '@/shared/dialogs/quick-chat/QuickChatHostSelect';

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
export type QuickChatDialogMode = 'quick' | 'autopilot' | 'drawer';
/** Tab order, also the order the pane-cycling keys move through. */
const QUICK_CHAT_MODES: readonly QuickChatDialogMode[] = [
  'quick',
  'autopilot',
  'drawer',
];

export interface QuickChatDialogProps {
  /** Tab to open on; defaults to Quick chat. */
  mode?: QuickChatDialogMode;
  /** Drawer note to select (implies the Drawer tab). */
  noteId?: string | null;
}

interface QuickChatHostPanelProps {
  /** The picked target: every request and every setting here belongs to it. */
  hostId: string | null;
  hostLabel: string;
  mode: QuickChatDialogMode;
  /** Dialog visibility; lookups run only while it is open. */
  visible: boolean;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  /** Folder, agent/model and uploads picked for this host (kept by the dialog). */
  hostDraft: QuickChatHostDraft;
  onHostDraftChange: (patch: QuickChatHostDraftPatch) => void;
  /** Appends an uploaded attachment's link to the prompt. */
  onInsertAttachmentMarkdown: (markdown: string) => void;
  submitting: boolean;
  onSubmittingChange: (submitting: boolean) => void;
  onOpenWorkspace: (workspaceId: string, hostId: string | null) => void;
}

/**
 * The host-owned half of the dialog: folder, attachments, agent/model choice
 * and the host's Autopilot. It is mounted per host (keyed by the caller), so
 * switching "Run on" starts clean instead of reusing the previous host's
 * selections. Config and profiles come from the surrounding
 * `HostUserSystemScope`, i.e. from this same host.
 */
function QuickChatHostPanel({
  hostId,
  hostLabel,
  mode,
  visible,
  prompt,
  onPromptChange,
  hostDraft,
  onHostDraftChange,
  onInsertAttachmentMarkdown,
  submitting,
  onSubmittingChange,
  onOpenWorkspace,
}: QuickChatHostPanelProps) {
  const {
    config,
    profiles,
    configError,
    configErrorMessage,
    configRefreshing,
    reloadSystem,
  } = useUserSystem();
  const queryClient = useQueryClient();
  const isAutopilotMode = mode === 'autopilot';

  // Held by the dialog, not here: this panel unmounts on every close, and the
  // folder and model picked for the prompt must survive that.
  const { repo, scratchConfig } = hostDraft;
  const setRepo = useCallback(
    (next: Repo | null) => onHostDraftChange({ repo: next }),
    [onHostDraftChange]
  );
  const setScratchConfig = useCallback(
    (
      next:
        | ExecutorConfig
        | null
        | ((prev: ExecutorConfig | null) => ExecutorConfig | null)
    ) =>
      onHostDraftChange((draft) => ({
        scratchConfig:
          typeof next === 'function' ? next(draft.scratchConfig) : next,
      })),
    [onHostDraftChange]
  );
  const handleAttachmentsChange = useCallback(
    (attachments: QuickChatHostDraft['attachments']) =>
      onHostDraftChange({ attachments }),
    [onHostDraftChange]
  );
  // Stop pressed while the request runs: stop the first turn once it exists.
  const [isStopRequested, setIsStopRequested] = useState(false);
  const stopRequestedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  // False once "Run on" moved away: work still in flight then belongs to the
  // previous host and must not land in the draft for the new one.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // The host's current Autopilot (null = none or paused). Only fetched while
  // the Autopilot tab is open; refetched after a pause so the form appears.
  const autopilotQuery = useQuery({
    queryKey: ['autopilot', hostId],
    queryFn: () => workspacesApi.getAutopilot(hostId),
    enabled: visible && isAutopilotMode,
    staleTime: 10 * 1000,
    // A refetch hides the form (see `autopilotKnown`), so none in the
    // background: only on open, on a tab or host switch, and after a pause.
    refetchOnWindowFocus: false,
  });
  // A cached "none" is not an answer while the lookup is being repeated.
  const autopilotKnown = autopilotQuery.isSuccess && !autopilotQuery.isFetching;
  const existingAutopilot = isAutopilotMode
    ? (autopilotQuery.data ?? null)
    : null;

  const favorites = useFolderFavoritesStore((s) => s.favorites);
  const addFavorite = useFolderFavoritesStore((s) => s.addFavorite);
  const removeFavorite = useFolderFavoritesStore((s) => s.removeFavorite);
  const visibleFavorites = favorites.filter(
    (favorite) => (favorite.hostId ?? null) === hostId
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
    hostId,
    onPersist: setScratchConfig,
  });

  // Attachments are uploaded before the workspace exists, then handed to the
  // quick-chat create call as ids; the markdown link is appended to the prompt.
  const handleInsertMarkdown = useCallback(
    (markdown: string) => {
      if (isMountedRef.current) onInsertAttachmentMarkdown(markdown);
    },
    [onInsertAttachmentMarkdown]
  );

  const { uploadFiles, getAttachmentIds, clearAttachments, localAttachments } =
    useCreateAttachments(
      handleInsertMarkdown,
      hostDraft.attachments,
      handleAttachmentsChange,
      hostId
    );

  // Drop files anywhere on the chat box, same as the workspace-create box.
  // `noClick`/`noKeyboard`: the paperclip owns those; the zone only handles drops.
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: uploadFiles,
    disabled: submitting || !repo,
    noClick: true,
    noKeyboard: true,
  });

  // Pre-fill the folder with the most recently used repo so the common case is
  // a single keystroke (type + send).
  useEffect(() => {
    if (!visible || repo) return;
    let cancelled = false;
    repoApi
      .listRecent(hostId)
      .then((recent) => {
        if (!cancelled && recent[0]) setRepo(recent[0]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, repo, hostId, setRepo]);

  // A reopen starts without the previous attempt's error.
  useEffect(() => {
    if (!visible) setError(null);
  }, [visible]);

  // Register a path as a repo and select it. Returns the repo on success so
  // callers (folder picker, favorite chips) can react; sets `error` and returns
  // null when the path isn't a git repository.
  const registerAndSelect = useCallback(
    async (path: string) => {
      try {
        const registered = await repoApi.register({ path }, hostId);
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
    [hostId, setRepo]
  );

  const pickFolder = useCallback(async () => {
    setError(null);
    const path = await FolderPickerDialog.show({
      value: repo?.path,
      title: 'Select a folder',
      description: 'The agent runs directly in this folder.',
      hostId,
    });
    if (!path) return;
    await registerAndSelect(path);
  }, [repo?.path, registerAndSelect, hostId]);

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
      removeFavorite(repo.path, hostId);
    } else {
      addFavorite({
        path: repo.path,
        name: repo.display_name || repo.name,
        hostId,
      });
    }
  }, [repo, isRepoFavorite, addFavorite, removeFavorite, hostId]);

  const handleExecutorChange = useCallback(
    (executor: BaseCodingAgent) => {
      setScratchConfig(
        (prev) =>
          ({ ...(prev ?? {}), executor, variant: null }) as ExecutorConfig
      );
    },
    [setScratchConfig]
  );

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
    [effectiveExecutor, setScratchConfig]
  );

  // The presets shown here are this host's, so that is whose settings open.
  const handleCustomise = useCallback(() => {
    SettingsDialog.show({
      initialSection: 'agents',
      initialHostId: hostId ?? 'local',
    });
  }, [hostId]);

  // Pause = archive: automation skips an archived Autopilot and the tab
  // offers the form again, so a new one can take a different folder or model.
  const pauseAutopilot = useCallback(async (): Promise<boolean> => {
    if (!existingAutopilot) return false;
    setPausing(true);
    setError(null);
    try {
      await workspacesApi.update(
        existingAutopilot.workspace.id,
        { archived: true },
        hostId
      );
      await autopilotQuery.refetch();
      return true;
    } catch (e) {
      setError(getErrorMessage(e) || 'Failed to pause the Autopilot.');
      return false;
    } finally {
      setPausing(false);
    }
  }, [existingAutopilot, hostId, autopilotQuery]);

  // Recreate = pause, then start the form on the same folder so only the
  // prompt or model needs changing.
  const recreateAutopilot = useCallback(async () => {
    const folder = existingAutopilot?.workspace.container_ref;
    if (!(await pauseAutopilot())) return;
    if (folder) await registerAndSelect(folder);
  }, [existingAutopilot, pauseAutopilot, registerAndSelect]);

  const handleSend = useCallback(async () => {
    if (!repo || !executorConfig || !prompt.trim()) return;
    onSubmittingChange(true);
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
          hostId
        );
      // Open straight into the new session with its first turn on screen (the
      // agent spawn continues server-side) — see useCreateWorkspace.
      if (session) {
        queryClient.setQueryData<Session[]>(
          workspaceSessionKeys.byWorkspace(workspace.id, hostId),
          [session]
        );
        selectWorkspaceSession(workspace.id, hostId, session.id);
      }
      seedOptimisticProcess(execution_process);
      if (stopRequestedRef.current && session) {
        // Failing that, the turn runs and can be stopped in the chat.
        await workspacesApi
          .stop(workspace.id, hostId, session.id)
          .catch((stopError) =>
            console.error('Failed to stop quick chat', stopError)
          );
      }
      // Sent: the draft is now the workspace's first message, so drop it.
      onPromptChange('');
      clearAttachments();
      if (isAutopilotMode) {
        void queryClient.invalidateQueries({
          queryKey: ['autopilot', hostId],
        });
      }
      onOpenWorkspace(workspace.id, hostId);
    } catch (e) {
      setError(
        getErrorMessage(e) ||
          (isAutopilotMode
            ? 'Failed to start the Autopilot.'
            : 'Failed to start quick chat.')
      );
      onSubmittingChange(false);
    }
  }, [
    repo,
    executorConfig,
    prompt,
    isAutopilotMode,
    getAttachmentIds,
    clearAttachments,
    queryClient,
    hostId,
    onPromptChange,
    onSubmittingChange,
    onOpenWorkspace,
  ]);

  // The Drawer tab has no host form; the panel stays mounted behind it so the
  // folder and model picked for this host are still there on the way back.
  if (mode === 'drawer') return null;

  const showForm =
    !isAutopilotMode ||
    canOfferAutopilotForm({
      isSuccess: autopilotKnown,
      hasAutopilot: !!existingAutopilot,
    });

  // Without the host's settings there are no agents to offer: say so, rather
  // than showing a form whose Send can never be pressed.
  if (configError && !config) {
    return (
      <div className="flex flex-wrap items-center gap-base text-sm text-error">
        <span>
          {`Could not load the settings of ${hostLabel}, so nothing can be started there yet.`}
          {configErrorMessage ? ` (${configErrorMessage})` : ''}
        </span>
        <button
          type="button"
          onClick={() => void reloadSystem()}
          disabled={configRefreshing}
          className="rounded-md border border-border px-base py-half text-normal hover:text-high disabled:opacity-50"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      {isAutopilotMode &&
        !existingAutopilot &&
        (autopilotQuery.isLoading || autopilotQuery.isFetching) && (
          <p className="text-sm text-low">Checking…</p>
        )}
      {isAutopilotMode &&
        autopilotQuery.isError &&
        !autopilotQuery.isFetching && (
          <div className="flex flex-wrap items-center gap-base text-sm text-error">
            <span>
              {`Could not check ${hostLabel} for an Autopilot: ${
                getErrorMessage(autopilotQuery.error) || 'the request failed.'
              }`}
            </span>
            <button
              type="button"
              onClick={() => void autopilotQuery.refetch()}
              disabled={autopilotQuery.isFetching}
              className="rounded-md border border-border px-base py-half text-normal hover:text-high disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        )}

      {isAutopilotMode && existingAutopilot && (
        <div className="flex flex-col gap-half rounded-md border border-border bg-secondary p-base">
          <div className="flex items-center gap-base">
            <RobotIcon weight="fill" className="size-icon-sm text-brand" />
            <span className="font-medium text-high">
              {existingAutopilot.workspace.name ?? 'Autopilot'}
            </span>
            <span className="shrink-0 rounded-sm border border-border px-1 text-sm text-low">
              {hostLabel}
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
              <span title="Last summary">
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
              onClick={() =>
                onOpenWorkspace(existingAutopilot.workspace.id, hostId)
              }
              className="rounded-md bg-brand px-base py-half text-sm font-medium text-on-brand hover:bg-brand-hover"
            >
              Open
            </button>
            <button
              type="button"
              onClick={pauseAutopilot}
              disabled={pausing}
              title="Archives it; the conversation stays. One Autopilot per host."
              className="rounded-md border border-border px-base py-half text-sm text-normal hover:text-high disabled:opacity-50"
            >
              {pausing ? 'Pausing…' : 'Pause'}
            </button>
            <button
              type="button"
              onClick={recreateAutopilot}
              disabled={pausing}
              title="Pause, then start again on this folder with a new prompt or model"
              className="rounded-md border border-border px-base py-half text-sm text-normal hover:text-high disabled:opacity-50"
            >
              Recreate…
            </button>
          </div>
          {error && <p className="text-sm text-error">{error}</p>}
        </div>
      )}

      {showForm && (
        <>
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

          {/* The chat box is `w-chat` wide (the conversation column); in the
              dialog it lines up with the rows above it instead. */}
          <div className="@container [&_.w-chat]:w-full">
            <CreateChatBox
              editor={{ value: prompt, onChange: onPromptChange }}
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
                      ? 'First instructions… (a starter AGENTS.md is written to the folder)'
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
                  hostId={hostId}
                  onPasteFiles={onPasteFiles}
                  localAttachments={localAttachments}
                  autoFocus
                  // Quick chat always keeps Return available for line breaks. Unlike
                  // regular workspace chat, it only starts an agent on Cmd/Ctrl+Return.
                  sendShortcut="ModifierEnter"
                />
              )}
              contextUsage={
                effectiveExecutor === BaseCodingAgent.CLAUDE_CODE ||
                effectiveExecutor === BaseCodingAgent.CODEX ? (
                  <ChatUsageIndicator
                    agent={effectiveExecutor}
                    hostId={hostId}
                  />
                ) : undefined
              }
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
                    hostId={hostId}
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
    </>
  );
}

const QuickChatDialogImpl = create<QuickChatDialogProps>((props) => {
  const modal = useModal();
  const appNavigation = useAppNavigation();
  const runtime = useAppRuntime();
  const routeHostId = useHostId();
  const {
    hosts,
    isLoading: hostsLoading,
    error: hostsError,
    retry: retryHosts,
  } = useWorkspaceHostOptions();
  const firstOnlineHostId =
    hosts.find((host) => host.status === 'online')?.id ?? null;
  const [prompt, setPrompt] = useState('');
  const [selectedHostId, setSelectedHostId] = useQuickChatHostSelection({
    visible: modal.visible,
    runtime,
    routeHostId,
    firstOnlineHostId,
    hasDraft: prompt.trim() !== '',
  });
  const { options: hostOptions, selected: selectedHost } = useMemo(
    () =>
      buildQuickChatHostOptions({
        runtime,
        hosts,
        hostsLoading,
        selectedHostId,
      }),
    [runtime, hosts, hostsLoading, selectedHostId]
  );
  const unavailableReason = describeUnavailableQuickChatHost(selectedHost, {
    hostsLoading,
    hostsFailed: !!hostsError,
  });
  // The folder, agent/model and uploads picked for the selected host. Kept
  // here because the per-host panel below unmounts on every close.
  const hostDraftKey = selectedHost
    ? (selectedHost.id ?? 'this-machine')
    : null;
  const [hostDraft, updateHostDraft] = useQuickChatHostDraft(hostDraftKey);
  const handleHostDraftChange = useCallback(
    (patch: QuickChatHostDraftPatch) => updateHostDraft(hostDraftKey, patch),
    [updateHostDraft, hostDraftKey]
  );
  // How the app opens a started chat is the app's own preference, not a
  // setting of whichever host the chat runs on or the document is showing.
  const openInNewPane = useAppUserSystem().config?.quick_chat_open_in_new_pane;
  // Set when a send handed the new workspace to a pane, so the dialog's close
  // focus restore stands down instead of yanking the caret back to its opener.
  const keepPaneFocusRef = useRef(false);

  // Links of files uploaded to the selected host, so they can leave the
  // prompt together with that host.
  const attachmentMarkdownRef = useRef<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<QuickChatDialogMode>(
    props.noteId ? 'drawer' : (props.mode ?? 'quick')
  );
  const isAutopilotMode = mode === 'autopilot';
  const isDrawerMode = mode === 'drawer';
  // The pane-cycling keys (ctrl+tab / ctrl+shift+tab by default) cycle the
  // dialog's tabs while it is open — the pane shortcuts are off behind a
  // modal anyway. A document capture listener: ahead of the focus trap's Tab
  // handling and of the editor (which claims Tab), and still there when a
  // tab switch has dropped focus to the body. Focus in another layer (a
  // dialog stacked on top) is left alone.
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);
  const nextTabKeys = resolveModifier(NEXT_SPLIT_PANE_BINDING_ID, overrides);
  const prevTabKeys = resolveModifier(
    PREVIOUS_SPLIT_PANE_BINDING_ID,
    overrides
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modal.visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const step = matchesCombo(event, nextTabKeys)
        ? 1
        : matchesCombo(event, prevTabKeys)
          ? -1
          : 0;
      if (step === 0) return;
      const dialog = dialogRef.current;
      const active = document.activeElement;
      if (active && active !== document.body && !dialog?.contains(active)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setMode((current) => {
        const count = QUICK_CHAT_MODES.length;
        const index = QUICK_CHAT_MODES.indexOf(current);
        return QUICK_CHAT_MODES[(index + step + count) % count];
      });
      // The switched-out tab takes the focused control with it.
      dialog?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [modal.visible, nextTabKeys, prevTabKeys]);
  // Escape with a Drawer note open returns to the list; only then does the
  // dialog's own Escape close it. Bubble phase, so a control inside the board
  // that handles Escape itself (the comment box) goes first.
  const drawerEscapeRef = useRef<(() => boolean) | null>(null);
  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      !isPlainEscape(event) ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing
    )
      return;
    if (isDrawerMode && drawerEscapeRef.current?.()) event.preventDefault();
  };
  // Unread count for the tab badge (the shape is shared with the tab itself).
  const { unreadCount: drawerUnread } = useDrawerNotes({
    enabled: modal.visible,
  });

  // nice-modal keeps this component mounted under the app layout, so React
  // state survives `hide()` and the post-send SPA navigation. Reset transient
  // state on dismissal so a reopen starts clean — otherwise a successful send
  // leaves `submitting` stuck (Send permanently disabled showing "Starting…").
  // The draft (prompt + its attachments + the folder it targets) and the
  // agent/model selection are intentionally preserved across reopens; the
  // draft is only cleared by a successful send, by the user emptying the
  // field, or by switching host. Keeping the folder matters: the prompt is
  // usually written *about* it, and silently reverting to the most recent
  // repo would run the agent in the wrong working tree.
  useEffect(() => {
    if (!modal.visible) {
      setSubmitting(false);
      // The ⚡ button means quick chat; the Autopilot tab is a deliberate pick.
      setMode('quick');
    }
  }, [modal.visible]);

  // A later `.show({ noteId })` on the already-mounted dialog retargets it.
  useEffect(() => {
    if (!modal.visible) return;
    if (props.noteId) setMode('drawer');
    else if (props.mode) setMode(props.mode);
  }, [modal.visible, props.noteId, props.mode]);

  const close = () => {
    modal.resolve(null);
    modal.hide();
  };

  const handlePromptChange = useCallback((next: string) => {
    if (!next) attachmentMarkdownRef.current = [];
    setPrompt(next);
  }, []);

  const handleInsertAttachmentMarkdown = useCallback((markdown: string) => {
    attachmentMarkdownRef.current.push(markdown);
    setPrompt((prev) => (prev.trim() ? `${prev}\n\n${markdown}` : markdown));
  }, []);

  const handleHostChange = (hostId: string | null) => {
    if (hostId === selectedHostId) return;
    // Files were uploaded to the previous host, so their links mean nothing
    // on the next one. The folder, model and attachment ids go with the
    // per-host panel.
    const staleLinks = attachmentMarkdownRef.current;
    attachmentMarkdownRef.current = [];
    if (staleLinks.length > 0) {
      setPrompt((prev) =>
        staleLinks
          .reduce((text, link) => text.split(link).join(''), prev)
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      );
    }
    setSelectedHostId(hostId);
  };

  // Route to a workspace and close. Used after a send and by "Open" on the
  // Autopilot card; the host is the one that request was made on.
  const openWorkspace = useCallback(
    (workspaceId: string, hostId: string | null) => {
      const goToDocument = () =>
        appNavigation.goToWorkspace(workspaceId, { hostId });
      // Route the chat before hiding: the dialog's close focus restore fires
      // as soon as the hide flushes, and it has to already know that a pane
      // took focus — otherwise it pulls the caret back to its opener.
      keepPaneFocusRef.current =
        !!openInNewPane &&
        openDestinationInOwnPane(
          { kind: 'workspace', workspaceId, hostId },
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
    [appNavigation, openInNewPane, runtime, modal]
  );

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
      ref={dialogRef}
      onKeyDown={handleDialogKeyDown}
      // Wide: room for the Drawer's list + note, and the editor is not
      // cramped either.
      size="wide"
      // KeyboardDialog stacks dialogs at the top (items-start). Quick chat is
      // short, so center it vertically. Inline style overrides the base `my-8`
      // (cn is clsx-only, so a `my-auto` class wouldn't win).
      style={{ marginTop: 'auto', marginBottom: 'auto' }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-base">
          {isDrawerMode ? (
            <TrayIcon weight="fill" className="size-icon-sm text-brand" />
          ) : isAutopilotMode ? (
            <RobotIcon weight="fill" className="size-icon-sm text-brand" />
          ) : (
            <LightningIcon weight="fill" className="size-icon-sm text-brand" />
          )}
          {isDrawerMode
            ? 'Drawer'
            : isAutopilotMode
              ? 'Autopilot'
              : 'Quick chat'}
        </DialogTitle>
        <DialogDescription>
          {isDrawerMode
            ? 'Reports from the Autopilot.'
            : isAutopilotMode
              ? 'Always-on agent for this host.'
              : 'Run an agent in an existing folder.'}
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
            ['drawer', 'Drawer', TrayIcon],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            title={
              value === 'drawer'
                ? 'Notes the Autopilot writes for you; comment to get a reply'
                : value === 'autopilot'
                  ? 'One per host; woken by automation; rules in its AGENTS.md'
                  : 'No branch, no isolation: edits land in the folder'
            }
            onClick={() => setMode(value)}
            className={`inline-flex items-center gap-half rounded px-base py-half ${
              mode === value
                ? 'bg-panel text-high shadow-[inset_0_-2px_0_hsl(var(--brand))]'
                : 'text-low hover:text-normal'
            }`}
          >
            <Icon weight="fill" className="size-icon-xs" />
            {label}
            {value === 'drawer' && drawerUnread > 0 && (
              <span className="ml-half inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-brand-secondary px-1 text-[10px] font-medium text-white">
                {drawerUnread > 99 ? '99+' : drawerUnread}
              </span>
            )}
          </button>
        ))}
      </div>

      {isDrawerMode && (
        // The board lays out by its container's width: measure the dialog's
        // content box the way a split pane is measured.
        <PaneWidthProvider>
          <DrawerTab
            initialNoteId={props.noteId ?? null}
            escapeRef={drawerEscapeRef}
            onOpenPage={(noteId) => {
              modal.resolve(null);
              modal.hide();
              appNavigation.goToDrawer(noteId ?? undefined);
            }}
          />
        </PaneWidthProvider>
      )}

      {!isDrawerMode && (
        <label className="flex items-center gap-base rounded-md border border-border bg-secondary px-base py-half">
          {selectedHostId ? (
            <ComputerTowerIcon className="size-icon-sm shrink-0 text-low" />
          ) : (
            <DesktopIcon className="size-icon-sm shrink-0 text-low" />
          )}
          <span className="text-sm text-low">Run on</span>
          <QuickChatHostSelect
            options={hostOptions}
            selected={selectedHost}
            // A request already under way keeps the target it started with.
            disabled={submitting}
            onChange={handleHostChange}
          />
        </label>
      )}

      {!isDrawerMode && unavailableReason && (
        <div
          className={`flex flex-wrap items-center gap-base text-sm ${
            hostsLoading ? 'text-low' : 'text-error'
          }`}
        >
          <span>
            {unavailableReason}
            {/* Why the list failed (signed out, cloud unreachable, …), where
                that is what the message is about: not for a host the list
                still shows as offline. */}
            {!hostsLoading && hostsError && selectedHost?.state !== 'offline'
              ? ` (${getErrorMessage(hostsError)})`
              : ''}
          </span>
          {!hostsLoading && (
            <button
              type="button"
              onClick={retryHosts}
              className="rounded-md border border-border px-base py-half text-normal hover:text-high"
            >
              Refresh hosts
            </button>
          )}
        </div>
      )}

      {/* Nothing is sent to a target that cannot take it. The panel is keyed
          by host and its draft is tagged with that host, so a folder,
          attachments and a model choice never carry over to another one. */}
      {selectedHost && !unavailableReason && (
        <HostUserSystemScope
          key={selectedHost.id ?? 'this-machine'}
          hostId={selectedHost.id}
          enabled={modal.visible}
        >
          <QuickChatHostPanel
            hostId={selectedHost.id}
            hostLabel={selectedHost.label}
            mode={mode}
            visible={modal.visible}
            prompt={prompt}
            onPromptChange={handlePromptChange}
            hostDraft={hostDraft}
            onHostDraftChange={handleHostDraftChange}
            onInsertAttachmentMarkdown={handleInsertAttachmentMarkdown}
            submitting={submitting}
            onSubmittingChange={setSubmitting}
            onOpenWorkspace={openWorkspace}
          />
        </HostUserSystemScope>
      )}
    </Dialog>
  );
});

export const QuickChatDialog = defineModal<
  QuickChatDialogProps | undefined,
  string | null
>(QuickChatDialogImpl);
