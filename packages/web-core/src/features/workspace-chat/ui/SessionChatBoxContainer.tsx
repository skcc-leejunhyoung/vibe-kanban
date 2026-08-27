import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDropzone } from 'react-dropzone';
import {
  type AskUserQuestionItem,
  BaseAgentCapability,
  type Session,
  type BaseCodingAgent,
  ExecutionProcessStatus,
  type ReviewError,
  type ExecutionProcess,
  type ExecutorActionType,
} from 'shared/types';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { useWorkspaceExecution } from '@/shared/hooks/useWorkspaceExecution';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { isCodingAgent } from '@/shared/constants/processes';
import { useWorkspaceRepo } from '@/shared/hooks/useWorkspaceRepo';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';
import { useApprovalFeedbackOptional } from '../model/contexts/ApprovalFeedbackContext';
import { useMessageEditContext } from '../model/contexts/MessageEditContext';
import { useEntries, useTokenUsage } from '../model/contexts/EntriesContext';
import { useExecutionProcesses } from '@/shared/hooks/useExecutionProcesses';
import { useReviewOptional } from '@/shared/hooks/useReview';
import { useActions } from '@/shared/hooks/useActions';
import { useTodos } from '../model/hooks/useTodos';
import {
  getInitialExecutorConfig,
  getLatestConfigFromProcesses,
} from '@/shared/lib/executor';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { useSessionMessageEditor } from '../model/hooks/useSessionMessageEditor';
import { useSessionQueueInteraction } from '../model/hooks/useSessionQueueInteraction';
import { useSessionSend } from '../model/hooks/useSessionSend';
import { useSessionAttachments } from '../model/hooks/useSessionAttachments';
import { useMessageEditRetry } from '../model/hooks/useMessageEditRetry';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { useWorkspaceBranch } from '../model/hooks/useWorkspaceBranch';
import { useApprovalMutation } from '../model/hooks/useApprovalMutation';
import { useApprovals } from '@/shared/hooks/useApprovals';
import { ResolveConflictsDialog } from '@/shared/dialogs/tasks/ResolveConflictsDialog';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { buildAgentPrompt } from '@/shared/lib/promptMessage';
import { formatDateShortWithTime } from '@/shared/lib/date';
import { toPrettyCase } from '@/shared/lib/string';
import {
  SessionChatBox,
  type ExecutionStatus,
  type SessionChatBoxEditorRenderProps,
} from '@vibe/ui/components/SessionChatBox';
import { ModelSelectorContainer } from '@/shared/components/ModelSelectorContainer';
import {
  useWorkspacePanelState,
  RIGHT_MAIN_PANEL_MODES,
} from '@/shared/stores/useUiPreferencesStore';
import { useInspectModeStore } from '../model/store/useInspectModeStore';
import { Actions } from '@/shared/actions';
import {
  isSpecialIcon,
  getActionTooltip,
  isActionEnabled,
  isActionVisible,
  type ActionDefinition,
} from '@/shared/types/actions';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { useActionVisibilityContext } from '@/shared/hooks/useActionVisibilityContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { sessionsApi, ApiError } from '@/shared/lib/api';
import { useWorkspaceRecord } from '@/shared/hooks/useWorkspaceRecord';
import { RenameSessionDialog } from '@vibe/ui/components/RenameSessionDialog';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { ErrorDialog } from '@vibe/ui/components/ErrorDialog';
import type { TurnNavigationItem } from '@vibe/ui/components/TurnNavigationPopup';
import {
  resumeReviewAndCreatePr,
  runReviewAndCreatePr,
} from '@/shared/lib/reviewAndCreatePr';

/** Compute execution status from boolean flags */
function computeExecutionStatus(params: {
  isInFeedbackMode: boolean;
  isInEditMode: boolean;
  isStopping: boolean;
  isQueueLoading: boolean;
  isSendingFollowUp: boolean;
  isAttemptRunning: boolean;
}): ExecutionStatus {
  if (params.isInFeedbackMode) return 'feedback';
  if (params.isInEditMode) return 'edit';
  if (params.isStopping) return 'stopping';
  if (params.isQueueLoading) return 'queue-loading';
  if (params.isSendingFollowUp) return 'sending';
  // A non-empty queue no longer locks the composer: while the agent runs the
  // box stays in 'running' so more messages can be queued or steered. Queued
  // messages are shown as a separate, removable list above the input.
  if (params.isAttemptRunning) return 'running';
  return 'idle';
}

/** Shared props across all modes */
interface SharedProps {
  /** Whether the chat editor should claim focus when it mounts. */
  autoFocus?: boolean;
  /** Available sessions for this workspace */
  sessions: Session[];
  /** Number of files changed in current session */
  filesChanged: number;
  /** Number of lines added */
  linesAdded: number;
  /** Number of lines removed */
  linesRemoved: number;
  /** Callback to scroll to previous user message */
  onScrollToPreviousMessage: () => void;
  /** Callback to scroll to bottom of conversation */
  onScrollToBottom: (behavior?: 'auto' | 'smooth') => void;
  /** Callback to scroll to a specific user message by patchKey */
  onScrollToUserMessage: (patchKey: string) => void;
  /** Returns the patchKey of the user message currently visible in the viewport */
  getActiveTurnPatchKey?: () => string | null;
  /** Disable the "view code" click handler (for VS Code extension) */
  disableViewCode: boolean;
  /** Replace diff stats with an "Open Workspace" button in header */
  showOpenWorkspaceButton: boolean;
}

/** Props for existing session mode */
interface ExistingSessionProps extends SharedProps {
  mode: 'existing-session';
  /** The current session */
  session: Session;
  /** Called when a session is selected */
  onSelectSession: (sessionId: string) => void;
  /** Callback to start new session mode */
  onStartNewSession: (() => void) | undefined;
}

/** Props for new session mode */
interface NewSessionProps extends SharedProps {
  mode: 'new-session';
  /** Workspace ID for creating new sessions */
  workspaceId: string;
  /** Called when a session is selected */
  onSelectSession: (sessionId: string) => void;
}

/** Props for placeholder mode (no workspace selected) */
interface PlaceholderProps extends SharedProps {
  mode: 'placeholder';
}

type SessionChatBoxContainerProps =
  | ExistingSessionProps
  | NewSessionProps
  | PlaceholderProps;

/** Map a vibe-review API failure to a localized message key. */
function reviewErrorKey(error: unknown): string {
  const data =
    error instanceof ApiError
      ? (error.error_data as ReviewError | undefined)
      : undefined;
  switch (data?.type) {
    case 'process_already_running':
      return 'conversation.review.alreadyRunning';
    case 'no_linked_issue':
      return 'conversation.review.noLinkedIssue';
    default:
      return 'conversation.review.failedDescription';
  }
}

// The user's prompt for a coding-agent turn lives in the execution-process
// metadata (executor_action), so the turn navigator can list every turn — even
// ones whose entries haven't been paged in yet — without loading their logs.
// Returns null for non-user processes (setup/cleanup/review scripts).
//
// Only the top-level action is inspected, never the `next_action` chain: a
// sequential setup-script process chains its `next_action` to the coding agent
// (setup → … → CodingAgentInitialRequest), so walking the chain would surface
// that prompt on the setup process too and produce a phantom duplicate turn.
// A genuine coding-agent process always carries the request at the top level
// (matches the `isFirstTurn` derivation in useConversationHistory).
function getUserPromptFromProcess(process: ExecutionProcess): string | null {
  const typ: ExecutorActionType = process.executor_action.typ;
  if (typ.type === 'CodingAgentInitialRequest' && typ.handoff_from != null) {
    return typ.handoff_user_prompt ?? null;
  }
  if (
    typ.type === 'CodingAgentInitialRequest' ||
    typ.type === 'CodingAgentFollowUpRequest'
  ) {
    return typ.prompt;
  }
  return null;
}

export function SessionChatBoxContainer(props: SessionChatBoxContainerProps) {
  const [isHandoffPending, setIsHandoffPending] = useState(false);
  const [handoffTarget, setHandoffTarget] = useState<BaseCodingAgent | null>(
    null
  );
  const {
    mode,
    sessions,
    filesChanged,
    linesAdded,
    linesRemoved,
    onScrollToPreviousMessage,
    onScrollToBottom,
    onScrollToUserMessage,
    getActiveTurnPatchKey,
    disableViewCode = false,
    showOpenWorkspaceButton,
    autoFocus = true,
  } = props;

  // Extract mode-specific values
  const session = mode === 'existing-session' ? props.session : undefined;
  const workspaceId =
    mode === 'existing-session'
      ? props.session.workspace_id
      : mode === 'new-session'
        ? props.workspaceId
        : undefined;
  const isNewSessionMode = mode === 'new-session';
  const onSelectSession =
    mode === 'placeholder' ? undefined : props.onSelectSession;
  const onStartNewSession =
    mode === 'existing-session' ? props.onStartNewSession : undefined;

  const sessionId = session?.id;
  useEffect(() => {
    setHandoffTarget(null);
  }, [sessionId]);
  const queryClient = useQueryClient();
  const hostId = useHostId();
  const { t } = useTranslation('tasks');
  const [isReviewing, setIsReviewing] = useState(false);
  useEffect(() => {
    if (workspaceId) {
      void resumeReviewAndCreatePr(workspaceId, hostId);
    }
  }, [workspaceId, hostId]);
  // Only issue-linked workspaces can enter the automated vibe review workflow;
  // gate the review button on a linked issue so it never advertises a call that
  // the backend is guaranteed to reject.
  const { data: reviewWorkspace } = useWorkspaceRecord(workspaceId);
  const hasLinkedIssue = reviewWorkspace?.task_id != null;

  const handleRenameSession = useCallback(
    (targetSessionId: string, currentName: string) => {
      void RenameSessionDialog.show({
        currentName,
        onRename: async (newName: string) => {
          await sessionsApi.update(targetSessionId, { name: newName }, hostId);
          void queryClient.invalidateQueries({
            queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
          });
        },
      });
    },
    [queryClient, hostId, workspaceId]
  );

  const handleDeleteSession = useCallback(
    (targetSessionId: string) => {
      void (async () => {
        const result = await ConfirmDialog.show({
          title: t('conversation.sessions.deleteTitle'),
          message: t('conversation.sessions.deleteDescription'),
          confirmText: t('conversation.sessions.delete'),
          variant: 'destructive',
        });
        if (result !== 'confirmed') return;
        try {
          await sessionsApi.delete(targetSessionId, hostId);
          void queryClient.invalidateQueries({
            queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
          });
        } catch (error) {
          // Surface backend failures (e.g. 409 while processes are running)
          // instead of swallowing them silently.
          void ErrorDialog.show({
            title: t('conversation.sessions.deleteFailedTitle'),
            message:
              error instanceof Error
                ? error.message
                : t('conversation.sessions.deleteFailedDescription'),
          });
        }
      })();
    },
    [queryClient, hostId, workspaceId, t]
  );

  // Usage-based auto-resume status for the current session. Polled so the
  // "waiting to resume" badge + countdown stay live.
  const autoResumeQuery = useQuery({
    queryKey: ['sessionAutoResume', hostId, sessionId],
    queryFn: () => sessionsApi.getAutoResume(sessionId!, hostId),
    enabled: !!sessionId,
    refetchInterval: 10000,
  });

  const autoResumeEnabled =
    autoResumeQuery.data?.enabled ?? session?.auto_resume_enabled ?? false;
  const autoResumePendingAt = autoResumeQuery.data?.pending_resume_at ?? null;

  const handleSetAutoResume = useCallback(
    (enabled: boolean) => {
      if (!sessionId) return;
      void (async () => {
        try {
          await sessionsApi.setAutoResume(sessionId, enabled, hostId);
        } finally {
          void queryClient.invalidateQueries({
            queryKey: ['sessionAutoResume', hostId, sessionId],
          });
          void queryClient.invalidateQueries({
            queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
          });
        }
      })();
    },
    [sessionId, hostId, workspaceId, queryClient]
  );

  // Cancelling a pending resume disables auto-resume for the session, which is
  // the only primitive the backend exposes (POST { enabled }).
  const handleCancelAutoResume = useCallback(() => {
    handleSetAutoResume(false);
  }, [handleSetAutoResume]);

  const appNavigation = useAppNavigation();

  const { executeAction } = useActions();
  const actionCtx = useActionVisibilityContext();
  const { rightMainPanelMode, setRightMainPanelMode } =
    useWorkspacePanelState(workspaceId);

  const handleViewCode = useCallback(() => {
    setRightMainPanelMode(
      rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES
        ? null
        : RIGHT_MAIN_PANEL_MODES.CHANGES
    );
  }, [rightMainPanelMode, setRightMainPanelMode]);

  const handleOpenWorkspace = useCallback(() => {
    if (!workspaceId) return;
    appNavigation.goToWorkspace(workspaceId);
  }, [appNavigation, workspaceId]);

  // Get entries early to extract pending approval for scratch key
  const { entries } = useEntries();
  const tokenUsageInfo = useTokenUsage();

  // Execution state
  const { isAttemptRunning, stopExecution, isStopping, processes } =
    useWorkspaceExecution(workspaceId);

  // Inject the follow-up process (returned by the send POST) so its turn shows
  // immediately, without waiting for the WS stream to deliver it.
  const {
    addOptimisticProcess,
    patchOptimisticProcess,
    removeOptimisticProcess,
    clearOptimisticProcess,
    reconcile: reconcileExecutionProcesses,
  } = useExecutionProcessesContext();

  // Stop, reflected immediately: mark the running coding-agent turn(s) killed so
  // the loading indicator clears and the box flips to idle before the WS stream
  // delivers the terminal status. Superseded by the stream; reverted if the stop
  // request fails.
  const handleStop = useCallback(async () => {
    const patchedIds: string[] = [];
    for (const p of processes) {
      if (isCodingAgent(p.run_reason) && p.status === 'running') {
        patchOptimisticProcess(p.id, {
          status: ExecutionProcessStatus.killed,
        });
        patchedIds.push(p.id);
      }
    }
    try {
      await stopExecution();
    } catch {
      patchedIds.forEach((id) => clearOptimisticProcess(id));
    }
  }, [
    processes,
    patchOptimisticProcess,
    clearOptimisticProcess,
    stopExecution,
  ]);

  // Extract user messages for turn navigation
  const userMessageTurns: TurnNavigationItem[] = useMemo(() => {
    // Every turn is derived from process metadata so the navigator lists the
    // whole conversation, not just what's been paged in. For turns already
    // loaded we reuse the real entry patchKey (instant scroll); for the rest we
    // carry a `proc:<id>` key that the handler resolves by paging history in.
    const loadedByProcess = new Map<
      string,
      { patchKey: string; content: string }
    >();
    for (const entry of entries) {
      if (
        entry.type === 'NORMALIZED_ENTRY' &&
        entry.content.entry_type.type === 'user_message' &&
        !loadedByProcess.has(entry.executionProcessId)
      ) {
        loadedByProcess.set(entry.executionProcessId, {
          patchKey: entry.patchKey,
          content: entry.content.content,
        });
      }
    }

    const turns: TurnNavigationItem[] = [];
    let turnNumber = 0;
    const ordered = [...processes].sort(
      (a, b) =>
        new Date(a.created_at as unknown as string).getTime() -
        new Date(b.created_at as unknown as string).getTime()
    );
    for (const process of ordered) {
      const prompt = getUserPromptFromProcess(process);
      if (prompt == null) continue;
      turnNumber++;
      const loaded = loadedByProcess.get(process.id);
      turns.push({
        patchKey: loaded ? loaded.patchKey : `proc:${process.id}`,
        content: loaded ? loaded.content : prompt,
        turnNumber,
      });
    }
    return turns;
  }, [entries, processes]);

  // Approvals state
  const { getPendingForProcess, pendingApprovals } = useApprovals();

  // Optimistically clear an approval the instant the user responds, so the
  // approve / request-changes / answer UI disappears immediately instead of
  // waiting for the approvals WS stream to drop it. Pruned once the stream no
  // longer reports the approval.
  const [resolvedApprovalIds, setResolvedApprovalIds] = useState<Set<string>>(
    new Set()
  );
  const resolveApprovalOptimistically = useCallback((approvalId: string) => {
    setResolvedApprovalIds((cur) => {
      if (cur.has(approvalId)) return cur;
      const next = new Set(cur);
      next.add(approvalId);
      return next;
    });
  }, []);
  useEffect(() => {
    setResolvedApprovalIds((cur) => {
      if (cur.size === 0) return cur;
      const stillPending = new Set(pendingApprovals.map((a) => a.approval_id));
      let changed = false;
      const next = new Set(cur);
      for (const id of cur) {
        if (!stillPending.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : cur;
    });
  }, [pendingApprovals]);

  // Get pending approval from running processes
  const pendingApproval = useMemo(() => {
    const runningProcesses = processes.filter(
      (p) => p.status === ExecutionProcessStatus.running
    );
    for (const proc of runningProcesses) {
      const info = getPendingForProcess(proc.id);
      if (info && !resolvedApprovalIds.has(info.approval_id)) {
        let questions: AskUserQuestionItem[] | undefined;
        for (const entry of entries) {
          if (entry.type !== 'NORMALIZED_ENTRY') continue;
          const entryType = entry.content.entry_type;
          if (
            entryType.type === 'tool_use' &&
            entryType.status.status === 'pending_approval' &&
            entryType.status.approval_id === info.approval_id &&
            entryType.action_type.action === 'ask_user_question'
          ) {
            questions = entryType.action_type.questions;
            break;
          }
        }
        return {
          approvalId: info.approval_id,
          timeoutAt: info.timeout_at,
          executionProcessId: info.execution_process_id,
          questions,
        };
      }
    }
    return null;
  }, [processes, getPendingForProcess, entries, resolvedApprovalIds]);

  // Use approval_id as scratch key when pending approval exists to avoid
  // prefilling approval response with queued follow-up message
  const scratchId = useMemo(() => {
    if (pendingApproval?.approvalId) {
      return pendingApproval.approvalId;
    }
    return isNewSessionMode ? workspaceId : sessionId;
  }, [pendingApproval?.approvalId, isNewSessionMode, workspaceId, sessionId]);

  // Get repos for file search
  const { repos } = useWorkspaceRepo(workspaceId);
  const repoIds = repos.map((r) => r.id);

  // Approval feedback context
  const feedbackContext = useApprovalFeedbackOptional();
  const isInFeedbackMode = !!feedbackContext?.activeApproval;

  // Message edit context
  const editContext = useMessageEditContext();
  const isInEditMode = editContext.isInEditMode;

  // Get todos from entries
  const { todos, inProgressTodo } = useTodos(entries);

  // Review comments context (optional - only available when ReviewProvider wraps this)
  const reviewContext = useReviewOptional();
  const reviewMarkdown = useMemo(
    () => reviewContext?.generateReviewMarkdown() ?? '',
    [reviewContext]
  );
  const hasReviewComments = (reviewContext?.comments.length ?? 0) > 0;

  // Approval mutation for approve/deny/answer actions
  const {
    approveAsync,
    denyAsync,
    answerAsync,
    isApproving,
    isDenying,
    isAnswering,
    denyError,
    answerError,
  } = useApprovalMutation();

  // Branch status for edit retry and conflict detection
  const { data: branchStatus } = useBranchStatus(workspaceId);

  // Derive conflict state from branch status
  const hasConflicts = useMemo(() => {
    return (
      branchStatus?.some((r) => (r.conflicted_files?.length ?? 0) > 0) ?? false
    );
  }, [branchStatus]);

  const conflictedFilesCount = useMemo(() => {
    return (
      branchStatus?.reduce(
        (sum, r) => sum + (r.conflicted_files?.length ?? 0),
        0
      ) ?? 0
    );
  }, [branchStatus]);

  // Get workspace branch for conflict resolution dialog
  const { branch: attemptBranch } = useWorkspaceBranch(workspaceId);

  // Find the first repo with conflicts (for the resolve dialog)
  const repoWithConflicts = useMemo(
    () =>
      branchStatus?.find(
        (r) => r.is_rebase_in_progress || (r.conflicted_files?.length ?? 0) > 0
      ),
    [branchStatus]
  );

  const handleResolveConflicts = useCallback(() => {
    if (!workspaceId || !repoWithConflicts) return;
    ResolveConflictsDialog.show({
      workspaceId,
      repoId: repoWithConflicts.repo_id,
      conflictOp: repoWithConflicts.conflict_op ?? 'rebase',
      sourceBranch: attemptBranch,
      targetBranch: repoWithConflicts.target_branch_name,
      conflictedFiles: repoWithConflicts.conflicted_files ?? [],
      repoName: repoWithConflicts.repo_name,
    });
  }, [workspaceId, repoWithConflicts, attemptBranch]);

  // User profiles, config preference, and latest executor from processes
  const { profiles, config, capabilities } = useUserSystem();

  // Fetch processes from last session to get full profile (only in new session mode)
  const lastSessionId = isNewSessionMode ? sessions?.[0]?.id : undefined;
  const { executionProcesses: lastSessionProcesses } =
    useExecutionProcesses(lastSessionId);

  // Compute latestConfig: current processes > last session processes > session metadata
  const latestConfig = useMemo(() => {
    // Current session's processes take priority (full ExecutorConfig)
    const fromProcesses = getLatestConfigFromProcesses(processes);
    if (fromProcesses) return fromProcesses;

    // Try full config from last session's processes
    const fromLastSession = getLatestConfigFromProcesses(lastSessionProcesses);
    if (fromLastSession) return fromLastSession;

    // Fallback: just executor from session metadata
    const lastSessionExecutor = sessions?.[0]?.executor;
    if (lastSessionExecutor) {
      return {
        executor: lastSessionExecutor as BaseCodingAgent,
      };
    }

    return null;
  }, [processes, lastSessionProcesses, sessions]);

  const needsExecutorSelection =
    isNewSessionMode || (!session?.executor && !latestConfig?.executor);
  const activeExecutor =
    latestConfig?.executor ??
    (session?.executor as BaseCodingAgent | null | undefined);

  // Message editor state
  const {
    localMessage,
    setLocalMessage,
    scratchData,
    isScratchLoading,
    hasInitialValue,
    saveToScratch,
    clearDraft,
    cancelDebouncedSave,
    handleMessageChange,
  } = useSessionMessageEditor({ scratchId });

  // Ref to access current message value for attachment handler
  const localMessageRef = useRef(localMessage);
  useEffect(() => {
    localMessageRef.current = localMessage;
  }, [localMessage]);

  // Attachment handling - insert markdown when attachments are uploaded
  const handleInsertMarkdown = useCallback(
    (markdown: string) => {
      const currentMessage = localMessageRef.current;
      const newMessage = currentMessage.trim()
        ? `${currentMessage}\n\n${markdown}`
        : markdown;
      setLocalMessage(newMessage);
    },
    [setLocalMessage]
  );

  // Auto-paste component context from inspect mode
  const pendingComponentMarkdown = useInspectModeStore(
    (s) => s.pendingComponentMarkdown
  );
  const clearPendingComponentMarkdown = useInspectModeStore(
    (s) => s.clearPendingComponentMarkdown
  );
  useEffect(() => {
    if (pendingComponentMarkdown) {
      handleInsertMarkdown(pendingComponentMarkdown);
      clearPendingComponentMarkdown();
    }
  }, [
    pendingComponentMarkdown,
    handleInsertMarkdown,
    clearPendingComponentMarkdown,
  ]);

  const { uploadFiles, localAttachments, clearUploadedAttachments } =
    useSessionAttachments(workspaceId, sessionId, handleInsertMarkdown);

  // Unified executor + variant + model selector options resolution
  const {
    executorConfig,
    effectiveExecutor,
    selectedVariant,
    executorOptions,
    variantOptions,
    presetOptions,
    setExecutor: handleExecutorChange,
    setVariant: setSelectedVariant,
    setOverrides: setExecutorOverrides,
  } = useExecutorConfig({
    profiles,
    lastUsedConfig: latestConfig,
    scratchConfig: scratchData?.executor_config ?? undefined,
    configExecutorProfile: config?.executor_profile,
    disabledExecutors: config?.disabled_executors,
    workspaceId,
    sessionId,
    onPersist: (cfg) => void saveToScratch(localMessageRef.current, cfg),
  });

  const supportsContextUsage =
    !!effectiveExecutor &&
    capabilities?.[effectiveExecutor]?.includes(
      BaseAgentCapability.CONTEXT_USAGE
    );

  // Navigate to agent settings to customise variants
  const handleCustomise = () => {
    SettingsDialog.show({ initialSection: 'agents' });
  };

  // Queue interaction
  const {
    queuedMessages,
    isQueueLoading,
    queueMessage,
    steer,
    steerQueued,
    updateQueued,
    isUpdatingQueued,
    reorderQueue,
    cancelQueue,
    cancelOne,
    refreshQueueStatus,
  } = useSessionQueueInteraction({
    sessionId,
    onQueueConsumed: reconcileExecutionProcesses,
  });

  // In-place editing of a queued message: the queued text is loaded into the
  // chat input (no dialog); confirm updates it in place, cancel restores the
  // draft that was being composed before the edit started.
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const editingQueuedBackupRef = useRef('');

  const exitQueuedEdit = useCallback(() => {
    setEditingQueuedId(null);
    cancelDebouncedSave();
    setLocalMessage(editingQueuedBackupRef.current);
    if (executorConfig) {
      // Restore the scratch draft too — typing during the edit debounce-saved
      // the queued text over it.
      void saveToScratch(editingQueuedBackupRef.current, executorConfig);
    }
    editingQueuedBackupRef.current = '';
  }, [cancelDebouncedSave, setLocalMessage, saveToScratch, executorConfig]);

  const handleEditQueued = useCallback(
    (messageId: string) => {
      const target = queuedMessages.find((m) => m.id === messageId);
      if (!target) return;
      // Queued edit and sent-message edit are mutually exclusive.
      editContext.cancelEdit();
      if (editingQueuedId === null) {
        editingQueuedBackupRef.current = localMessage;
      }
      setEditingQueuedId(messageId);
      cancelDebouncedSave();
      setLocalMessage(target.data.message);
    },
    [
      queuedMessages,
      editContext,
      editingQueuedId,
      localMessage,
      cancelDebouncedSave,
      setLocalMessage,
    ]
  );

  const handleSubmitQueuedEdit = useCallback(async () => {
    if (!editingQueuedId || !localMessage.trim() || !executorConfig) return;
    try {
      await updateQueued(editingQueuedId, localMessage, executorConfig);
    } catch {
      return; // stay in edit mode so the user can retry or cancel
    }
    exitQueuedEdit();
  }, [
    editingQueuedId,
    localMessage,
    executorConfig,
    updateQueued,
    exitQueuedEdit,
  ]);

  // The edited message can be consumed (turn finished) or removed while the
  // user is still typing — drop out of edit mode instead of targeting a
  // message that no longer exists.
  useEffect(() => {
    if (
      editingQueuedId &&
      !queuedMessages.some((m) => m.id === editingQueuedId)
    ) {
      exitQueuedEdit();
    }
  }, [editingQueuedId, queuedMessages, exitQueuedEdit]);

  // Send actions
  const {
    send,
    isSending,
    error: sendError,
    clearError,
  } = useSessionSend({
    sessionId,
    workspaceId,
    isNewSessionMode,
    onSelectSession,
    executorConfig,
    onOptimisticProcess: addOptimisticProcess,
  });

  const handleHandoff = useCallback(
    (target: BaseCodingAgent) => {
      if (handoffTarget === target) {
        setHandoffTarget(null);
        if (activeExecutor) {
          handleExecutorChange(activeExecutor);
        }
        return;
      }
      setHandoffTarget(target);
      handleExecutorChange(target);
    },
    [handoffTarget, activeExecutor, handleExecutorChange]
  );

  useEffect(() => {
    if (
      mode === 'existing-session' &&
      activeExecutor &&
      effectiveExecutor &&
      activeExecutor !== effectiveExecutor
    ) {
      setHandoffTarget(effectiveExecutor);
    } else if (activeExecutor === effectiveExecutor) {
      setHandoffTarget(null);
    }
  }, [mode, activeExecutor, effectiveExecutor]);

  const sendHandoff = useCallback(
    async (prompt: string): Promise<boolean> => {
      if (!sessionId || !handoffTarget) {
        return false;
      }
      setIsHandoffPending(true);
      try {
        const process = await sessionsApi.handoff(
          sessionId,
          {
            prompt,
            executor_config:
              executorConfig?.executor === handoffTarget
                ? executorConfig
                : getInitialExecutorConfig(handoffTarget, profiles),
          },
          hostId
        );
        setHandoffTarget(null);
        addOptimisticProcess(process);
        await queryClient.invalidateQueries({
          queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
        });
        onScrollToBottom('auto');
        return true;
      } catch (error) {
        void ErrorDialog.show({
          title: t('conversation.handoff.failedTitle'),
          message:
            error instanceof Error
              ? error.message
              : t('conversation.handoff.failedDescription'),
        });
        return false;
      } finally {
        setIsHandoffPending(false);
      }
    },
    [
      sessionId,
      handoffTarget,
      executorConfig,
      profiles,
      addOptimisticProcess,
      queryClient,
      workspaceId,
      hostId,
      onScrollToBottom,
      t,
    ]
  );

  const handleSend = useCallback(async () => {
    const { prompt, isSlashCommand } = buildAgentPrompt(localMessage, [
      reviewMarkdown,
    ]);

    onScrollToBottom('auto');

    const success = handoffTarget
      ? await sendHandoff(prompt)
      : await send(prompt);
    if (success) {
      cancelDebouncedSave();
      setLocalMessage('');
      clearUploadedAttachments();
      // Clear the persisted draft for both new and existing sessions so the
      // sent prompt doesn't reappear when navigating back to the chat.
      await clearDraft();
      if (!isSlashCommand) {
        reviewContext?.clearComments();
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          onScrollToBottom('auto');
        });
      });
    }
  }, [
    onScrollToBottom,
    send,
    sendHandoff,
    handoffTarget,
    localMessage,
    reviewMarkdown,
    cancelDebouncedSave,
    setLocalMessage,
    clearUploadedAttachments,
    clearDraft,
    reviewContext,
  ]);

  // Start an automated `vibe` review (as if the coding agent had reported
  // VIBE_RESULT: done): the backend spawns a dedicated review session and drives
  // the review → merge workflow. Switch to the new session so the user can watch.
  const handleVibeReview = useCallback(async () => {
    if (!sessionId || isReviewing) return;
    setIsReviewing(true);
    try {
      const reviewSession = await sessionsApi.vibeReview(
        sessionId,
        hostId,
        executorConfig
      );
      await queryClient.invalidateQueries({
        queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
      });
      onSelectSession?.(reviewSession.id);
    } catch (error) {
      void ErrorDialog.show({
        title: t('conversation.review.failedTitle'),
        message: t(reviewErrorKey(error)),
      });
    } finally {
      setIsReviewing(false);
    }
  }, [
    sessionId,
    isReviewing,
    workspaceId,
    hostId,
    executorConfig,
    queryClient,
    onSelectSession,
    t,
  ]);

  const handleVibeReviewAndCreatePr = useCallback(async () => {
    if (!sessionId || !workspaceId || isReviewing) return;
    setIsReviewing(true);
    try {
      await runReviewAndCreatePr({
        workspaceId,
        sessionId,
        hostId,
        executorConfig,
        queryClient,
        onReviewSession: onSelectSession,
      });
    } catch (error) {
      void ErrorDialog.show({
        title: t(
          'conversation.reviewAndCreatePr.failedTitle',
          'Review and create PR failed'
        ),
        message:
          error instanceof Error
            ? error.message
            : t(
                'conversation.reviewAndCreatePr.failed',
                'The review and pull request workflow failed.'
              ),
      });
    } finally {
      setIsReviewing(false);
    }
  }, [
    sessionId,
    isReviewing,
    workspaceId,
    hostId,
    executorConfig,
    queryClient,
    onSelectSession,
    t,
  ]);

  // Track previous process count for queue refresh
  const prevProcessCountRef = useRef(processes.length);

  // Refresh queue status when execution stops or new process starts
  useEffect(() => {
    const prevCount = prevProcessCountRef.current;
    prevProcessCountRef.current = processes.length;

    if (!workspaceId) return;

    if (!isAttemptRunning) {
      refreshQueueStatus();
      return;
    }

    if (processes.length > prevCount) {
      refreshQueueStatus();
    }
  }, [isAttemptRunning, workspaceId, processes.length, refreshQueueStatus]);

  // Queue message handler — append the composed message to the back of the queue
  const handleQueueMessage = useCallback(async () => {
    // Allow queueing if there's a message OR review comments, and we have a config
    if ((!localMessage.trim() && !reviewMarkdown) || !executorConfig) return;

    const { prompt } = buildAgentPrompt(localMessage, [reviewMarkdown]);

    cancelDebouncedSave();
    await queueMessage(prompt, executorConfig);

    // Clear local state after queueing (same as handleSend). The message now
    // lives in the server-side queue, so drop the local draft too.
    setLocalMessage('');
    clearUploadedAttachments();
    reviewContext?.clearComments();
    await clearDraft();
  }, [
    localMessage,
    reviewMarkdown,
    executorConfig,
    queueMessage,
    cancelDebouncedSave,
    setLocalMessage,
    clearUploadedAttachments,
    reviewContext,
    clearDraft,
  ]);

  // Steer / "send now" handler — interrupt the running turn (or, when idle,
  // behave like a normal send) and run the composed message immediately.
  const handleSteer = useCallback(async () => {
    if (!isAttemptRunning) {
      await handleSend();
      return;
    }
    if ((!localMessage.trim() && !reviewMarkdown) || !executorConfig) return;

    const { prompt } = buildAgentPrompt(localMessage, [reviewMarkdown]);

    cancelDebouncedSave();
    onScrollToBottom('auto');
    await steer(prompt, executorConfig);

    setLocalMessage('');
    clearUploadedAttachments();
    reviewContext?.clearComments();
    await clearDraft();
  }, [
    isAttemptRunning,
    handleSend,
    localMessage,
    reviewMarkdown,
    executorConfig,
    steer,
    cancelDebouncedSave,
    onScrollToBottom,
    setLocalMessage,
    clearUploadedAttachments,
    reviewContext,
    clearDraft,
  ]);

  // Remove a single queued message by id
  const handleRemoveQueued = useCallback(
    (messageId: string) => {
      void cancelOne(messageId);
    },
    [cancelOne]
  );

  // "Send now" on an already-queued message: run it next, interrupting the turn
  const handleSteerQueued = useCallback(
    (messageId: string) => {
      void steerQueued(messageId);
    },
    [steerQueued]
  );

  // Reorder the queue to a new id order (driven by the up/down arrows)
  const handleReorderQueued = useCallback(
    (messageIds: string[]) => {
      void reorderQueue(messageIds);
    },
    [reorderQueue]
  );

  // Editor change handler
  const handleEditorChange = useCallback(
    (value: string) => {
      if (executorConfig) {
        handleMessageChange(value, executorConfig);
      } else {
        setLocalMessage(value);
      }
      if (sendError) clearError();
    },
    [
      handleMessageChange,
      executorConfig,
      sendError,
      clearError,
      setLocalMessage,
    ]
  );

  // Handle feedback submission
  const handleSubmitFeedback = useCallback(async () => {
    if (!feedbackContext || !localMessage.trim()) return;
    try {
      await feedbackContext.submitFeedback(localMessage);
      cancelDebouncedSave();
      setLocalMessage('');
      await clearDraft();
    } catch {
      // Error is handled in context
    }
  }, [
    feedbackContext,
    localMessage,
    cancelDebouncedSave,
    setLocalMessage,
    clearDraft,
  ]);

  // Handle cancel feedback mode
  const handleCancelFeedback = useCallback(() => {
    feedbackContext?.exitFeedbackMode();
  }, [feedbackContext]);

  // Handle cancel queue - clear all queued messages
  const handleCancelQueue = useCallback(async () => {
    await cancelQueue();
  }, [cancelQueue]);

  // Message edit retry mutation
  const editRetryMutation = useMessageEditRetry(sessionId ?? '', () => {
    // On success, clear edit mode and reset editor
    editContext.cancelEdit();
    cancelDebouncedSave();
    setLocalMessage('');
  });

  const areAttachmentInputsDisabled =
    mode === 'placeholder' ||
    isSending ||
    isStopping ||
    !!feedbackContext?.isSubmitting ||
    editRetryMutation.isPending ||
    isApproving ||
    isDenying ||
    isAnswering;

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        uploadFiles(acceptedFiles);
      }
    },
    [uploadFiles]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    disabled: areAttachmentInputsDisabled,
    noClick: true,
    noKeyboard: true,
  });

  // Handle edit submission
  const handleSubmitEdit = useCallback(async () => {
    if (!editContext.activeEdit || !localMessage.trim() || !executorConfig)
      return;
    // Retry drops the edited turn and everything created at/after it, then runs
    // a new turn — reflect both immediately (reset + send). Backend drops
    // `created_at >= target`; the new process is returned by the mutation.
    const targetId = editContext.activeEdit.processId;
    const target = processes.find((p) => p.id === targetId);
    const idsToRemove =
      target != null
        ? processes
            .filter(
              (p) =>
                !p.dropped &&
                new Date(p.created_at as unknown as string).getTime() >=
                  new Date(target.created_at as unknown as string).getTime()
            )
            .map((p) => p.id)
        : [targetId];
    editRetryMutation.mutate(
      {
        message: localMessage,
        executorConfig,
        executionProcessId: targetId,
        branchStatus,
        processes,
      },
      {
        onSuccess: (process) => {
          idsToRemove.forEach((id) => removeOptimisticProcess(id));
          addOptimisticProcess(process);
        },
      }
    );
  }, [
    editContext.activeEdit,
    localMessage,
    executorConfig,
    branchStatus,
    processes,
    editRetryMutation,
    removeOptimisticProcess,
    addOptimisticProcess,
  ]);

  // Handle cancel edit mode
  const handleCancelEdit = useCallback(() => {
    editContext.cancelEdit();
    setLocalMessage('');
  }, [editContext, setLocalMessage]);

  // Populate editor with original message when entering edit mode
  const prevEditRef = useRef(editContext.activeEdit);
  useEffect(() => {
    if (editContext.activeEdit && !prevEditRef.current) {
      // Just entered edit mode - populate with original message. A queued-edit
      // in progress is superseded (the two modes share the input).
      setEditingQueuedId(null);
      editingQueuedBackupRef.current = '';
      setLocalMessage(editContext.activeEdit.originalMessage);
    }
    prevEditRef.current = editContext.activeEdit;
  }, [editContext.activeEdit, setLocalMessage]);

  // Toolbar actions handler
  const handleToolbarAction = useCallback(
    (action: ActionDefinition) => {
      if (action.requiresTarget && workspaceId) {
        executeAction(action, workspaceId);
      } else {
        executeAction(action);
      }
    },
    [executeAction, workspaceId]
  );

  // Define which actions appear in the toolbar
  const toolbarActionsList = useMemo(
    () =>
      [Actions.AddReviewComments].filter((action) =>
        isActionVisible(action, actionCtx)
      ),
    [actionCtx]
  );

  const toolbarActionItems = useMemo(
    () =>
      toolbarActionsList.flatMap((action) => {
        if (isSpecialIcon(action.icon)) {
          return [];
        }

        const label = action.label;

        return [
          {
            id: action.id,
            icon: action.icon,
            label,
            tooltip: getActionTooltip(action, actionCtx),
            disabled: !isActionEnabled(action, actionCtx),
            onClick: () => handleToolbarAction(action),
          },
        ];
      }),
    [toolbarActionsList, actionCtx, handleToolbarAction]
  );

  // Handle approve action
  const handleApprove = useCallback(async () => {
    if (!pendingApproval) return;
    const approvalId = pendingApproval.approvalId;

    // Exit feedback mode if active
    feedbackContext?.exitFeedbackMode();

    try {
      await approveAsync({
        approvalId,
        executionProcessId: pendingApproval.executionProcessId,
      });
      resolveApprovalOptimistically(approvalId);

      // Invalidate workspace summary cache to update sidebar
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      onScrollToBottom();
    } catch {
      // Error is handled by mutation
    }
  }, [
    pendingApproval,
    feedbackContext,
    approveAsync,
    resolveApprovalOptimistically,
    queryClient,
    onScrollToBottom,
  ]);

  // Handle request changes (deny with feedback)
  const handleRequestChanges = useCallback(async () => {
    if (!pendingApproval || !localMessage.trim()) return;
    const approvalId = pendingApproval.approvalId;

    try {
      await denyAsync({
        approvalId,
        executionProcessId: pendingApproval.executionProcessId,
        reason: localMessage.trim(),
      });
      resolveApprovalOptimistically(approvalId);
      cancelDebouncedSave();
      setLocalMessage('');
      await clearDraft();

      // Invalidate workspace summary cache to update sidebar
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      onScrollToBottom();
    } catch {
      // Error is handled by mutation
    }
  }, [
    pendingApproval,
    localMessage,
    denyAsync,
    resolveApprovalOptimistically,
    cancelDebouncedSave,
    setLocalMessage,
    clearDraft,
    queryClient,
    onScrollToBottom,
  ]);

  // Handle AskUserQuestion answer submission
  const handleAnswerQuestion = useCallback(
    async (answers: Array<{ question: string; answer: string[] }>) => {
      if (!pendingApproval) return;
      const approvalId = pendingApproval.approvalId;

      try {
        await answerAsync({
          approvalId,
          executionProcessId: pendingApproval.executionProcessId,
          answers,
        });
        resolveApprovalOptimistically(approvalId);
        queryClient.invalidateQueries({
          queryKey: workspaceSummaryKeys.all,
        });
        onScrollToBottom();
      } catch {
        // Error is handled by mutation
      }
    },
    [
      pendingApproval,
      answerAsync,
      resolveApprovalOptimistically,
      queryClient,
      onScrollToBottom,
    ]
  );

  // Check if approval is timed out
  const isApprovalTimedOut = pendingApproval
    ? new Date() > new Date(pendingApproval.timeoutAt)
    : false;

  const status = computeExecutionStatus({
    isInFeedbackMode,
    isInEditMode: isInEditMode || editingQueuedId !== null,
    isStopping,
    isQueueLoading,
    isSendingFollowUp: isSending || isHandoffPending,
    isAttemptRunning,
  });

  // During loading, render with empty editor to preserve container UI.
  // The editor always shows the local draft; queued messages live in their own
  // list above the input.
  const editorValue = useMemo(() => {
    if (isScratchLoading || !hasInitialValue) return '';
    return localMessage;
  }, [isScratchLoading, hasInitialValue, localMessage]);

  const renderEditor = useCallback(
    ({
      focusKey,
      placeholder,
      value,
      onChange,
      onCmdEnter,
      disabled,
      repoIds,
      executor,
      onPasteFiles,
      localAttachments,
    }: SessionChatBoxEditorRenderProps<BaseCodingAgent>) => (
      <WYSIWYGEditor
        key={focusKey}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onCmdEnter={onCmdEnter}
        disabled={disabled}
        fillHeight
        // fillHeight makes the editor the internal scroll region so it grows
        // with content but shrinks (scrolling) once the height-capped chat box
        // wrapper is reached, keeping the conversation visible and the footer
        // pinned. max-h-[50vh] is a secondary upper cap.
        className="min-h-0 flex-1 max-h-[50vh] overflow-y-auto"
        repoIds={repoIds}
        executor={executor}
        sessionId={sessionId}
        autoFocus={autoFocus}
        onPasteFiles={onPasteFiles}
        localAttachments={localAttachments}
        sendShortcut={config?.send_message_shortcut}
      />
    ),
    [autoFocus, config?.send_message_shortcut, sessionId]
  );

  const modelSelectorNode = effectiveExecutor ? (
    <ModelSelectorContainer
      agent={effectiveExecutor}
      workspaceId={workspaceId}
      sessionId={sessionId}
      onAdvancedSettings={handleCustomise}
      presets={variantOptions}
      selectedPreset={selectedVariant}
      onPresetSelect={setSelectedVariant}
      onOverrideChange={setExecutorOverrides}
      executorConfig={executorConfig}
      presetOptions={presetOptions}
    />
  ) : undefined;

  // In placeholder mode, render a disabled version to maintain visual structure
  if (mode === 'placeholder') {
    return (
      <SessionChatBox<BaseCodingAgent>
        status="idle"
        fillHeight
        renderEditor={renderEditor}
        repoIds={repoIds}
        tokenUsageInfo={tokenUsageInfo}
        supportsContextUsage={false}
        formatExecutorLabel={toPrettyCase}
        formatSessionDate={(createdAt) =>
          formatDateShortWithTime(
            createdAt instanceof Date ? createdAt.toISOString() : createdAt
          )
        }
        renderAgentIcon={(executor, className) => (
          <AgentIcon
            agent={executor as BaseCodingAgent | null | undefined}
            className={className}
          />
        )}
        editor={{
          value: '',
          onChange: () => {},
        }}
        actions={{
          onSend: () => {},
          onQueue: () => {},
          onSteer: () => {},
          onCancelQueue: () => {},
          onStop: () => {},
          onPasteFiles: () => {},
        }}
        session={{
          sessions: [],
          selectedSessionId: undefined,
          onSelectSession: () => {},
          isNewSessionMode: false,
          onNewSession: undefined,
        }}
        stats={{
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
        }}
        onViewCode={disableViewCode ? undefined : handleViewCode}
      />
    );
  }

  return (
    <SessionChatBox<BaseCodingAgent>
      status={status}
      fillHeight
      onViewCode={disableViewCode ? undefined : handleViewCode}
      onOpenWorkspace={
        showOpenWorkspaceButton && workspaceId ? handleOpenWorkspace : undefined
      }
      onScrollToPreviousMessage={onScrollToPreviousMessage}
      userMessageTurns={userMessageTurns}
      onScrollToUserMessage={onScrollToUserMessage}
      getActiveTurnPatchKey={getActiveTurnPatchKey}
      renderEditor={renderEditor}
      repoIds={repoIds}
      tokenUsageInfo={tokenUsageInfo}
      supportsContextUsage={supportsContextUsage}
      autoResume={
        sessionId
          ? {
              enabled: autoResumeEnabled,
              pendingResumeAt: autoResumePendingAt,
              onToggle: handleSetAutoResume,
              onCancelPending: handleCancelAutoResume,
            }
          : undefined
      }
      formatExecutorLabel={toPrettyCase}
      formatSessionDate={(createdAt) =>
        formatDateShortWithTime(
          createdAt instanceof Date ? createdAt.toISOString() : createdAt
        )
      }
      renderAgentIcon={(executor, className) => (
        <AgentIcon
          agent={executor as BaseCodingAgent | null | undefined}
          className={className}
        />
      )}
      editor={{
        value: editorValue,
        onChange: handleEditorChange,
      }}
      actions={{
        onSend: handleSend,
        onQueue: handleQueueMessage,
        onSteer: handleSteer,
        onCancelQueue: handleCancelQueue,
        onStop: handleStop,
        onPasteFiles: uploadFiles,
        onVibeReview:
          sessionId && hasLinkedIssue ? handleVibeReview : undefined,
        onVibeReviewAndCreatePr:
          sessionId && hasLinkedIssue ? handleVibeReviewAndCreatePr : undefined,
        isReviewing,
      }}
      queuedMessages={queuedMessages.map((m) => ({
        id: m.id,
        message: m.data.message,
      }))}
      onRemoveQueued={handleRemoveQueued}
      onSteerQueued={handleSteerQueued}
      onEditQueued={handleEditQueued}
      editingQueuedId={editingQueuedId}
      onReorderQueued={handleReorderQueued}
      session={{
        sessions,
        selectedSessionId: sessionId,
        onSelectSession: onSelectSession ?? (() => {}),
        isNewSessionMode: needsExecutorSelection,
        onNewSession: onStartNewSession,
        onRenameSession: handleRenameSession,
        onDeleteSession: handleDeleteSession,
      }}
      toolbarActions={{
        items: toolbarActionItems,
      }}
      handoff={
        mode === 'existing-session' && activeExecutor
          ? {
              current: activeExecutor,
              selected: handoffTarget,
              options: executorOptions,
              onChange: handleHandoff,
              disabled: isAttemptRunning || isHandoffPending,
            }
          : undefined
      }
      stats={{
        filesChanged,
        linesAdded,
        linesRemoved,
        hasConflicts,
        conflictedFilesCount,
        onResolveConflicts: handleResolveConflicts,
      }}
      error={sendError}
      agent={effectiveExecutor}
      todos={todos}
      inProgressTodo={inProgressTodo}
      executor={
        needsExecutorSelection
          ? {
              selected: effectiveExecutor,
              options: executorOptions,
              onChange: handleExecutorChange,
            }
          : undefined
      }
      feedbackMode={
        feedbackContext
          ? {
              isActive: isInFeedbackMode,
              onSubmitFeedback: handleSubmitFeedback,
              onCancel: handleCancelFeedback,
              isSubmitting: feedbackContext.isSubmitting,
              error: feedbackContext.error,
              isTimedOut: feedbackContext.isTimedOut,
            }
          : undefined
      }
      approvalMode={
        pendingApproval && !pendingApproval.questions
          ? {
              isActive: true,
              onApprove: handleApprove,
              onRequestChanges: handleRequestChanges,
              isSubmitting: isApproving || isDenying,
              isTimedOut: isApprovalTimedOut,
              error: denyError?.message ?? null,
            }
          : undefined
      }
      askQuestionMode={
        pendingApproval?.questions
          ? {
              isActive: true,
              questions: pendingApproval.questions,
              onSubmitAnswers: handleAnswerQuestion,
              isSubmitting: isAnswering,
              isTimedOut: isApprovalTimedOut,
              error: answerError?.message ?? null,
            }
          : undefined
      }
      editMode={
        editingQueuedId !== null
          ? {
              isActive: true,
              onSubmitEdit: () => void handleSubmitQueuedEdit(),
              onCancel: exitQueuedEdit,
              isSubmitting: isUpdatingQueued,
              submitLabel: t('conversation.actions.confirmEdit'),
            }
          : {
              isActive: isInEditMode,
              onSubmitEdit: handleSubmitEdit,
              onCancel: handleCancelEdit,
              isSubmitting: editRetryMutation.isPending,
            }
      }
      reviewComments={
        hasReviewComments && reviewContext
          ? {
              count: reviewContext.comments.length,
              previewMarkdown: reviewMarkdown,
              onClear: reviewContext.clearComments,
            }
          : undefined
      }
      localAttachments={localAttachments}
      dropzone={{ getRootProps, getInputProps, isDragActive }}
      modelSelector={modelSelectorNode}
    />
  );
}
