import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDropzone } from 'react-dropzone';
import {
  type AskUserQuestionItem,
  BaseAgentCapability,
  type Session,
  type BaseCodingAgent,
  type ExecutionProcess,
  ExecutionProcessStatus,
  type ExecutorConfig,
  type ReviewError,
} from 'shared/types';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { useWorkspaceExecution } from '@/shared/hooks/useWorkspaceExecution';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import {
  createPendingProcess,
  matchArrivedProcess,
} from '@/shared/providers/executionProcessScope';
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
import {
  isOptimisticQueuedId,
  QueuedAfterFailedSendError,
  useSessionQueueInteraction,
} from '../model/hooks/useSessionQueueInteraction';
import { useSessionSend } from '../model/hooks/useSessionSend';
import { useSessionAttachments } from '../model/hooks/useSessionAttachments';
import {
  RestoreLogsDialog,
  type RestoreLogsDialogResult,
} from '@/shared/dialogs/tasks/RestoreLogsDialog';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { useAfterAgentTurnRefetch } from '@/shared/hooks/useAfterAgentTurnRefetch';
import { useWorkspaceBranch } from '../model/hooks/useWorkspaceBranch';
import { useApprovalMutation } from '../model/hooks/useApprovalMutation';
import { useApprovals } from '@/shared/hooks/useApprovals';
import { ResolveConflictsDialog } from '@/shared/dialogs/tasks/ResolveConflictsDialog';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { buildAgentPrompt } from '@/shared/lib/promptMessage';
import { publishChatExecutorConfig } from '@/shared/lib/chatExecutorConfig';
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
import {
  sessionsApi,
  workspacesApi,
  queueApi,
  ApiError,
} from '@/shared/lib/api';
import { useWorkspaceRecord } from '@/shared/hooks/useWorkspaceRecord';
import { RenameSessionDialog } from '@vibe/ui/components/RenameSessionDialog';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { ErrorDialog } from '@vibe/ui/components/ErrorDialog';
import type { TurnNavigationItem } from '@vibe/ui/components/TurnNavigationPopup';
import { buildTurnNavigationItems } from '../model/turnNavigation';
import {
  resumeReviewAndCreatePr,
  runReviewAndCreatePr,
} from '@/shared/lib/reviewAndCreatePr';

/** Compute execution status from boolean flags */
function computeExecutionStatus(params: {
  isInFeedbackMode: boolean;
  isInEditMode: boolean;
  isStopping: boolean;
  /** New-session row being created: the composer locks briefly. */
  isCreating: boolean;
  /** Follow-up POST in flight: its placeholder turn is already on screen. */
  isSendingFollowUp: boolean;
  isAttemptRunning: boolean;
}): ExecutionStatus {
  if (params.isInFeedbackMode) return 'feedback';
  if (params.isInEditMode) return 'edit';
  if (params.isStopping) return 'stopping';
  if (params.isCreating) return 'creating';
  if (params.isSendingFollowUp) return 'sending';
  // A non-empty queue no longer locks the composer: while the agent runs the
  // box stays in 'running' so more messages can be queued or steered. Queued
  // messages are shown as a separate, removable list above the input.
  if (params.isAttemptRunning) return 'running';
  return 'idle';
}

/**
 * A follow-up send whose POST hasn't returned (or is still finishing up).
 * Kept per session at module level: a conversation switch or a composer
 * remount (the kanban sidebar keys its provider per session) must neither
 * lose the deferred stop / double-send guard nor forget to show the turn
 * again on return.
 */
interface PendingSend {
  placeholder: ExecutionProcess;
  /** Process ids known at send time, to recognise the new row on the stream. */
  knownIds: Set<string>;
  /** The sent prompt as the server stores it (trimmed), for the same. */
  prompt: string;
  stopRequested: boolean;
  /** The real process once known (POST returned or streamed earlier). */
  process: ExecutionProcess | null;
  /**
   * The request returned: the agent is registered and a stop reaches it. The
   * stream shows the row before that; a stop is then deferred to the answer.
   * ("Send now" has no answer to wait for; it stops on adoption and relies on
   * the server re-checking for a child registered during the stop.)
   */
  spawned: boolean;
  /** Kill the real process: optimistic status + session-scoped stop. */
  stopReal: (processId: string) => void;
  /** "Send now": nothing to await after the steer answers, so the entry is
   * done as soon as the turn it became is adopted from the stream. */
  settleOnAdopt?: boolean;
  /** "Send now": the queue row the server shows for the same message. */
  hideQueuedId?: string | null;
  /** "Send now": settles once a stop sent through `stopReal` has answered. */
  whenStopped?: () => Promise<void> | undefined;
  /** "Send now": the steer request (settles, never rejects). */
  steerRequest?: Promise<unknown>;
  /** The request of a `runPendingSend`: true once it succeeded. */
  requestSettled?: Promise<boolean>;
  /** "Send now": put the text back when a stop leaves it unsent. */
  onAbandoned?: () => void;
}

const STEER_STOP_GRACE_MS = 5_000;
const logStopError = (error: unknown) =>
  console.error('Failed to stop a pending "send now"', error);
const pendingSends = new Map<string, PendingSend>();
/**
 * Processes whose deferred stop request failed. Every composer that showed
 * the stop on one of them (its own overlay copy) takes it back; announced
 * through the pending-send store version.
 */
const failedStops = new Set<string>();

const latestCreatedAtMs = (processes: ExecutionProcess[]) =>
  processes.reduce(
    (latest, p) => Math.max(latest, Date.parse(p.created_at) || 0),
    0
  );
/**
 * Prompt of a send that failed after the user had left its session, to be put
 * back into that session's composer on return. Drafts are per runtime (server
 * scratch locally, localStorage on remote-web), so this stays in memory rather
 * than guessing where the composer will read from.
 */
const unsentPrompts = new Map<string, string>();
// Tiny external store so every composer showing a session (split panes, the
// kanban sidebar) re-renders when a pending send changes, not just the one
// whose closure made the change.
let pendingSendsVersion = 0;
const pendingSendsListeners = new Set<() => void>();
function pendingSendsChanged() {
  pendingSendsVersion += 1;
  pendingSendsListeners.forEach((listener) => listener());
}
function subscribePendingSends(listener: () => void) {
  pendingSendsListeners.add(listener);
  return () => {
    pendingSendsListeners.delete(listener);
  };
}
const getPendingSendsVersion = () => pendingSendsVersion;

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

export function SessionChatBoxContainer(props: SessionChatBoxContainerProps) {
  // New-session mode: creating the session row (fast) before the first
  // message goes out as a pending follow-up.
  const [isCreatingSession, setIsCreatingSession] = useState(false);
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
  // Session this composer is showing, or undefined once it unmounts (the
  // kanban sidebar remounts per session), so a send settling later knows
  // whether its own composer can still take the text back.
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
    setHandoffTarget(null);
    return () => {
      sessionIdRef.current = undefined;
    };
  }, [sessionId]);
  // Re-render when the pending-send registry changes (it lives outside React).
  const pendingVersion = useSyncExternalStore(
    subscribePendingSends,
    getPendingSendsVersion
  );
  const pendingSend = sessionId ? pendingSends.get(sessionId) : undefined;
  // The turn this composer marked as stopped in its own overlay while a send
  // was pending (taken back if that stop fails, see `failedStops`).
  const stopShownIdRef = useRef<string | null>(null);
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

  // Usage-based auto-resume status for the current session. Only the pending
  // countdown needs to tick; otherwise this is a slow backup poll. A resume is
  // only ever scheduled as a turn ends (maybe_schedule_rate_limit_resume runs
  // in the same post-terminal block as the auto-commit), so the turn-end
  // refetch below is what makes the badge appear; the setter invalidates the
  // key directly.
  const autoResumeQuery = useQuery({
    queryKey: ['sessionAutoResume', hostId, sessionId],
    queryFn: () => sessionsApi.getAutoResume(sessionId!, hostId),
    enabled: !!sessionId,
    refetchInterval: (query) =>
      query.state.data?.pending_resume_at ? 10_000 : 60_000,
  });
  useAfterAgentTurnRefetch(!!sessionId, autoResumeQuery.refetch);

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
    void executeAction(Actions.OpenWorkspace, workspaceId);
  }, [executeAction, workspaceId]);

  // Get entries early to extract pending approval for scratch key
  const { entries } = useEntries();
  const tokenUsageInfo = useTokenUsage();

  // Execution state
  const { isAttemptRunning, stopExecution, isStopping, processes } =
    useWorkspaceExecution(workspaceId, sessionId);

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
    const pending = sessionId ? pendingSends.get(sessionId) : undefined;
    if (pending) {
      if (pending.stopRequested) return;
      pending.stopRequested = true;
      pendingSendsChanged();
      if (pending.spawned && pending.process) {
        // The request has returned and the send is only finishing up: the
        // agent is registered, so kill it right away.
        pending.stopReal(pending.process.id);
        return;
      }
      if (pending.settleOnAdopt && !pending.process && sessionId) {
        // "Send now" whose turn hasn't shown up. Don't depend on a composer
        // being here to adopt it: drop the queue now (a stop does that on the
        // server anyway) so the pinned message never becomes a turn, and stop
        // the session. A turn already on its way gets a moment to appear (the
        // adopt effect stops it); then stop once more and settle.
        const stoppedSession = sessionId;
        const stopWorkspace = workspaceId;
        const stopAll = async () => {
          await queueApi.cancel(stoppedSession, hostId).catch(logStopError);
          if (!stopWorkspace) return undefined;
          return workspacesApi
            .stop(stopWorkspace, hostId, stoppedSession)
            .then(() => undefined)
            .catch((error: unknown) => {
              logStopError(error);
              return error;
            });
        };
        void (async () => {
          await stopAll();
          // The steer may still be on its way (held while the old turn
          // drains, or relayed late) and start the message after the stop
          // above: wait for it, then clear and stop again.
          await pending.steerRequest;
          if (pendingSends.get(stoppedSession) !== pending) return;
          await stopAll();
          await new Promise((resolve) =>
            setTimeout(resolve, STEER_STOP_GRACE_MS)
          );
          if (pendingSends.get(stoppedSession) !== pending) return;
          if (pending.process) return; // adopted: stopped there
          const failed = await stopAll();
          if (pendingSends.get(stoppedSession) !== pending) return;
          pendingSends.delete(stoppedSession);
          pendingSendsChanged();
          // It never became a turn: don't lose the text.
          pending.onAbandoned?.();
          if (failed) {
            void ErrorDialog.show({
              title: t('common:error'),
              message:
                failed instanceof Error ? failed.message : String(failed),
            });
          }
        })();
      }
      // Nothing the server can kill yet: mark the turn shown (only where this
      // overlay shows it); the real process is killed once it can be.
      const shownId = pending.process?.id ?? pending.placeholder.id;
      if (processes.some((p) => p.id === shownId)) {
        patchOptimisticProcess(shownId, {
          status: ExecutionProcessStatus.killed,
        });
        stopShownIdRef.current = shownId;
      }
      return;
    }
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
    } catch (error) {
      patchedIds.forEach((id) => clearOptimisticProcess(id));
      void ErrorDialog.show({
        title: t('common:error'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    sessionId,
    workspaceId,
    hostId,
    processes,
    patchOptimisticProcess,
    clearOptimisticProcess,
    stopExecution,
    t,
  ]);

  // Extract user messages for turn navigation
  const userMessageTurns: TurnNavigationItem[] = useMemo(
    () => buildTurnNavigationItems(entries, processes),
    [entries, processes]
  );

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
  // Answers the server refused, shown selected again when the banner returns.
  const refusedAnswersRef = useRef<
    Record<string, Array<{ question: string; answer: string[] }>>
  >({});
  // The server refused the response: bring the approval UI back.
  const unresolveApproval = useCallback((approvalId: string) => {
    setResolvedApprovalIds((cur) => {
      if (!cur.has(approvalId)) return cur;
      const next = new Set(cur);
      next.delete(approvalId);
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
    loadedScratchId,
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

  // Expose the composer's resolved agent selection to command palette actions
  // (Start Review / Review and create PR) so they run with this config instead
  // of the backend's last-executed fallback. Published entries persist past
  // unmount on purpose: the palette must honor the selection even while the
  // chat panel is hidden (narrow-pane changes view, hidden left panel).
  useEffect(() => {
    if (!sessionId || !executorConfig) return;
    publishChatExecutorConfig(sessionId, executorConfig);
  }, [sessionId, executorConfig]);

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
    queueMessage,
    steer,
    steerQueued,
    updateQueued,
    reorderQueue,
    cancelQueue,
    cancelOne,
    dropQueuedLocally,
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
      if (isOptimisticQueuedId(messageId)) return;
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
    const messageId = editingQueuedId;
    const message = localMessage;
    // The list already shows the edit; leave edit mode now and only report a
    // refusal (the list is rolled back by the hook).
    const editedSession = sessionId;
    exitQueuedEdit();
    try {
      await updateQueued(messageId, message, executorConfig);
    } catch (error) {
      // The list rolled back: keep the edit in the composer, in front of the
      // draft that came back when edit mode closed.
      if (sessionIdRef.current === editedSession) {
        const draft = localMessageRef.current;
        const restored = draft.trim() ? `${message}\n\n${draft}` : message;
        cancelDebouncedSave();
        setLocalMessage(restored);
        void saveToScratch(restored, executorConfig);
      }
      void ErrorDialog.show({
        title: t('common:error'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    editingQueuedId,
    localMessage,
    executorConfig,
    sessionId,
    updateQueued,
    exitQueuedEdit,
    cancelDebouncedSave,
    setLocalMessage,
    saveToScratch,
    t,
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
    error: sendError,
    clearError,
  } = useSessionSend({
    sessionId,
    workspaceId,
    executorConfig,
  });

  // Any composer showing a session whose send is pending (switch, remount, a
  // second pane, or the send just started elsewhere): make sure its overlay
  // shows the turn. Idempotent — adds are de-duplicated by id. Every provider
  // showing the session holds its own copy of the placeholder, so each
  // composer also drops its copy once the real process is known, the send has
  // settled or it shows another session — not just the composer that sent.
  const shownPlaceholderIdRef = useRef<string | null>(null);
  // A stop this composer showed whose request failed: take it back here too.
  useEffect(() => {
    const shownStop = stopShownIdRef.current;
    if (shownStop && failedStops.has(shownStop)) {
      patchOptimisticProcess(shownStop, {
        status: ExecutionProcessStatus.running,
      });
      stopShownIdRef.current = null;
    }
  }, [pendingVersion, patchOptimisticProcess]);
  useEffect(() => {
    const pending = sessionId ? pendingSends.get(sessionId) : undefined;
    const placeholderId =
      pending && !pending.process ? pending.placeholder.id : null;
    if (
      shownPlaceholderIdRef.current &&
      shownPlaceholderIdRef.current !== placeholderId
    ) {
      clearOptimisticProcess(shownPlaceholderIdRef.current);
    }
    shownPlaceholderIdRef.current = placeholderId;
    if (!pending) return;
    const shown = pending.process ?? pending.placeholder;
    addOptimisticProcess(shown);
    if (pending.stopRequested) {
      patchOptimisticProcess(shown.id, {
        status: ExecutionProcessStatus.killed,
      });
      stopShownIdRef.current = shown.id;
    }
  }, [
    sessionId,
    pendingVersion,
    addOptimisticProcess,
    patchOptimisticProcess,
    clearOptimisticProcess,
  ]);

  // The stream publishes the new row on insert, the POST only returns after
  // the spawn: adopt our process as soon as it shows up so the placeholder
  // never sits next to it (two user bubbles). A deferred stop waits for the
  // request's answer (`PendingSend.spawned`), except "send now", which has none.
  useEffect(() => {
    if (!sessionId) return;
    const pending = pendingSends.get(sessionId);
    if (!pending || pending.process) return;
    const arrived = matchArrivedProcess(processes, { sessionId, ...pending });
    if (!arrived) return;
    clearOptimisticProcess(pending.placeholder.id);
    pending.process = arrived;
    if (pending.stopRequested && pending.settleOnAdopt) {
      pending.stopReal(arrived.id);
    } else if (pending.stopRequested) {
      // Keep showing the stop on the real row until the answer lets it go out.
      patchOptimisticProcess(arrived.id, {
        status: ExecutionProcessStatus.killed,
      });
      stopShownIdRef.current = arrived.id;
    }
    if (pending.hideQueuedId) dropQueuedLocally(pending.hideQueuedId);
    if (pending.settleOnAdopt) {
      const settle = () => {
        if (pendingSends.get(sessionId) !== pending) return;
        pendingSends.delete(sessionId);
        pendingSendsChanged();
      };
      // A stopped one stays registered until the stop answered, so every
      // pane keeps showing it stopped and the composer says "stopping".
      if (pending.stopRequested) {
        void Promise.resolve(pending.whenStopped?.()).then(settle);
      } else {
        settle();
      }
    }
    pendingSendsChanged();
  }, [
    sessionId,
    processes,
    clearOptimisticProcess,
    patchOptimisticProcess,
    dropQueuedLocally,
  ]);

  // An unmounted composer can't drop its provider's copy of the placeholder
  // any more (the provider may outlive it), so drop it now; a composer showing
  // the session again re-adds it while the send is still pending.
  useEffect(() => {
    const shownPlaceholder = shownPlaceholderIdRef;
    return () => {
      if (shownPlaceholder.current) {
        clearOptimisticProcess(shownPlaceholder.current);
      }
    };
  }, [clearOptimisticProcess]);

  // A send that failed after the user had left: put its text back in front of
  // whatever this session's draft holds, once that draft (not an approval's,
  // not the previous session's) has loaded.
  useEffect(() => {
    if (!sessionId || scratchId !== sessionId || loadedScratchId !== sessionId)
      return;
    const unsent = unsentPrompts.get(sessionId);
    if (unsent === undefined) return;
    unsentPrompts.delete(sessionId);
    const draft = localMessageRef.current;
    const restored = draft.trim() ? `${unsent}\n\n${draft}` : unsent;
    cancelDebouncedSave();
    setLocalMessage(restored);
    if (executorConfig) void saveToScratch(restored, executorConfig);
  }, [
    sessionId,
    scratchId,
    loadedScratchId,
    pendingVersion,
    cancelDebouncedSave,
    setLocalMessage,
    saveToScratch,
    executorConfig,
  ]);

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

  // Stop pressed while a send is pending: kill the real process as soon as it
  // is known, once. Ids are captured, not read from hooks, so a session switch
  // in the meantime can't redirect the stop.
  const createStopReal = useCallback(
    (workspaceIdForStop: string, target: string) => {
      const deferred: { stop?: Promise<void> } = {};
      const stopReal = (processId: string) => {
        if (deferred.stop) return;
        failedStops.delete(processId);
        patchOptimisticProcess(processId, {
          status: ExecutionProcessStatus.killed,
        });
        deferred.stop = workspacesApi
          .stop(workspaceIdForStop, hostId, target)
          .catch((error) => {
            patchOptimisticProcess(processId, {
              status: ExecutionProcessStatus.running,
            });
            // Let a second Stop try again, and take the stop back everywhere
            // it is shown (other panes patched their own copy).
            deferred.stop = undefined;
            const entry = pendingSends.get(target);
            if (entry?.stopReal === stopReal) entry.stopRequested = false;
            failedStops.add(processId);
            pendingSendsChanged();
            void ErrorDialog.show({
              title: t('common:error'),
              message: error instanceof Error ? error.message : String(error),
            });
          });
      };
      return { deferred, stopReal };
    },
    [patchOptimisticProcess, hostId, t]
  );

  // Put a prompt the server refused back in front of whatever has been typed
  // since, and keep it as the draft — if `target` is still the session on
  // screen; otherwise it is restored when that session is shown again.
  const restorePrompt = useCallback(
    (
      target: string,
      prompt: string,
      executorConfigForDraft: ExecutorConfig,
      where: 'before' | 'after' = 'before'
    ) => {
      if (sessionIdRef.current !== target) {
        const earlier = unsentPrompts.get(target);
        unsentPrompts.set(target, earlier ? `${earlier}\n\n${prompt}` : prompt);
        pendingSendsChanged();
        return;
      }
      const draft = localMessageRef.current;
      const restored = !draft.trim()
        ? prompt
        : where === 'before'
          ? `${prompt}\n\n${draft}`
          : `${draft}\n\n${prompt}`;
      // A debounced save of what was typed meanwhile would overwrite this.
      cancelDebouncedSave();
      setLocalMessage(restored);
      void saveToScratch(restored, executorConfigForDraft);
    },
    [setLocalMessage, saveToScratch, cancelDebouncedSave]
  );

  // Send `prompt` into `target` with `placeholder` shown as its turn right
  // away; `request` makes the server call and resolves with the created
  // process. Shared by follow-ups, handoffs and edit/retry: the entry in the
  // registry gives stop-while-pending, adoption from the stream and the
  // re-show on remount; a refusal takes the turn down and puts the text back.
  const runPendingSend = useCallback(
    async ({
      target,
      workspaceIdForStop,
      prompt,
      placeholder,
      request,
      onFailure,
    }: {
      target: string;
      workspaceIdForStop: string;
      prompt: string;
      placeholder: ExecutionProcess;
      request: () => Promise<ExecutionProcess>;
      onFailure?: (error: unknown) => void;
    }): Promise<boolean> => {
      const { deferred, stopReal } = createStopReal(workspaceIdForStop, target);
      const pendingState: PendingSend = {
        placeholder,
        knownIds: new Set(processes.map((p) => p.id)),
        prompt: prompt.trim(),
        stopRequested: false,
        process: null,
        spawned: false,
        stopReal,
      };
      let settleRequest: (ok: boolean) => void = () => {};
      pendingState.requestSettled = new Promise<boolean>((resolve) => {
        settleRequest = resolve;
      });
      pendingSends.set(target, pendingState);
      pendingSendsChanged();
      addOptimisticProcess(placeholder);
      let success = false;
      try {
        const process = await request();
        pendingState.spawned = true;
        // Not our turn: another one had just started, and the server put this
        // message at the front of the queue. Show it there.
        if (
          !matchArrivedProcess([process], {
            sessionId: target,
            knownIds: new Set(),
            prompt: pendingState.prompt,
          })
        ) {
          void refreshQueueStatus();
        }
        // Swap the placeholder for the real row in one render. Drop our copy
        // even when the row was adopted from the stream: another pane may have
        // adopted it, leaving ours unswapped. Adds are session-guarded, so this
        // is safe after a switch.
        clearOptimisticProcess(placeholder.id);
        if (!pendingState.process) {
          addOptimisticProcess(process);
          pendingState.process = process;
        }
        pendingSendsChanged(); // other composers swap their copy too
        if (pendingState.stopRequested) stopReal(process.id);
        success = true;
      } catch (error) {
        // The request can fail after the server started the agent (e.g. the
        // relay dropped the answer); a stop asked for meanwhile still goes out.
        // The stop is session-scoped, so it needs no process id.
        if (pendingState.stopRequested) {
          stopReal(pendingState.process?.id ?? placeholder.id);
        }
        onFailure?.(error);
      }
      settleRequest(success);
      await deferred.stop;
      if (pendingSends.get(target) === pendingState) {
        pendingSends.delete(target);
      }
      if (!success) {
        clearOptimisticProcess(placeholder.id);
        if (executorConfig) {
          restorePrompt(target, prompt, executorConfig);
        } else {
          unsentPrompts.set(target, prompt);
        }
      }
      pendingSendsChanged();
      return success;
    },
    [
      processes,
      executorConfig,
      createStopReal,
      addOptimisticProcess,
      clearOptimisticProcess,
      restorePrompt,
      refreshQueueStatus,
    ]
  );

  const handleSend = useCallback(async () => {
    const { prompt, isSlashCommand } = buildAgentPrompt(localMessage, [
      reviewMarkdown,
    ]);

    onScrollToBottom('auto');

    const resetComposer = async () => {
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
    };

    if (!workspaceId || !executorConfig) {
      // Nothing to send into; the hook reports why.
      try {
        await send(prompt);
        await resetComposer();
      } catch {
        // Shown by the chat box.
      }
      return;
    }

    // Handoff: the turn (with its "from → to" line) shows at once under the
    // new agent; the server bootstraps the new native session meanwhile.
    if (handoffTarget && sessionId) {
      const to = handoffTarget;
      const targetConfig =
        executorConfig.executor === to
          ? executorConfig
          : getInitialExecutorConfig(to, profiles);
      const placeholder = createPendingProcess(
        sessionId,
        prompt,
        targetConfig,
        latestCreatedAtMs(processes),
        { handoffFrom: activeExecutor ?? executorConfig.executor }
      );
      setHandoffTarget(null);
      const sending = runPendingSend({
        target: sessionId,
        workspaceIdForStop: workspaceId,
        prompt,
        placeholder,
        request: async () => {
          const process = await sessionsApi.handoff(
            sessionId,
            { prompt, executor_config: targetConfig },
            hostId
          );
          void queryClient.invalidateQueries({
            queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
          });
          return process;
        },
        onFailure: (error) => {
          void ErrorDialog.show({
            title: t('conversation.handoff.failedTitle'),
            message:
              error instanceof Error
                ? error.message
                : t('conversation.handoff.failedDescription'),
          });
        },
      });
      await resetComposer();
      await sending;
      return;
    }

    let targetSessionId = sessionId;
    if (!targetSessionId) {
      // New session: create the row first (fast) and switch to it, so the
      // first message can go out as a pending follow-up and show up at once.
      setIsCreatingSession(true);
      try {
        const created = await sessionsApi.create(
          {
            workspace_id: workspaceId,
            executor: executorConfig.executor,
            variant: executorConfig.variant ?? null,
          },
          hostId
        );
        queryClient.setQueryData<Session[]>(
          workspaceSessionKeys.byWorkspace(workspaceId, hostId),
          (current) => [
            created,
            ...(current ?? []).filter((s) => s.id !== created.id),
          ]
        );
        onSelectSession?.(created.id);
        targetSessionId = created.id;
      } catch (error) {
        void ErrorDialog.show({
          title: t('common:error'),
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      } finally {
        setIsCreatingSession(false);
      }
    }
    const target = targetSessionId;

    // Follow-up: show the turn and free the composer right away. The POST can
    // take a while (container check, previous turn drain, agent spawn).
    const sending = runPendingSend({
      target,
      workspaceIdForStop: workspaceId,
      prompt,
      placeholder: createPendingProcess(
        target,
        prompt,
        executorConfig,
        latestCreatedAtMs(processes)
      ),
      request: () => send(prompt, { sessionId: target }),
      // The hook shows the error in this composer; one that has been
      // remounted (new session: the page remounts it on switch) or left has
      // nowhere to show it.
      onFailure: (error) => {
        if (sessionIdRef.current !== target) {
          void ErrorDialog.show({
            title: t('common:error'),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
    await resetComposer();
    await sending;
  }, [
    onScrollToBottom,
    send,
    handoffTarget,
    activeExecutor,
    profiles,
    sessionId,
    workspaceId,
    hostId,
    queryClient,
    onSelectSession,
    executorConfig,
    localMessage,
    reviewMarkdown,
    cancelDebouncedSave,
    setLocalMessage,
    clearUploadedAttachments,
    clearDraft,
    reviewContext,
    processes,
    runPendingSend,
    t,
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

    // The row is on the list at once (optimistic); free the composer now and
    // put the text back only if the server refuses it.
    cancelDebouncedSave();
    setLocalMessage('');
    clearUploadedAttachments();
    reviewContext?.clearComments();
    void clearDraft();
    const pending = sessionId ? pendingSends.get(sessionId) : undefined;
    const after =
      pending && !pending.spawned ? pending.requestSettled : undefined;
    try {
      await queueMessage(prompt, executorConfig, after);
    } catch (error) {
      if (error instanceof QueuedAfterFailedSendError) {
        // The send before it failed and was put back already (with its own
        // error): this one goes back after it.
        if (sessionId)
          restorePrompt(sessionId, prompt, executorConfig, 'after');
        return;
      }
      if (sessionId) restorePrompt(sessionId, prompt, executorConfig);
      void ErrorDialog.show({
        title: t('common:error'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
    restorePrompt,
    t,
  ]);

  // Steer / "send now" handler — interrupt the running turn (or, when idle,
  // behave like a normal send) and run the composed message immediately.
  const handleSteer = useCallback(async () => {
    if (!isAttemptRunning) {
      await handleSend();
      return;
    }
    if ((!localMessage.trim() && !reviewMarkdown) || !executorConfig) return;
    if (!sessionId || !workspaceId) return;

    const { prompt } = buildAgentPrompt(localMessage, [reviewMarkdown]);

    cancelDebouncedSave();
    onScrollToBottom('auto');

    // Show the message as the next turn right away. The server pins it at the
    // front of the queue and kills the running turn; the turn it then starts
    // is adopted from the stream like a pending send, and the queue row the
    // server shows for it meanwhile is hidden.
    const pending = createPendingProcess(
      sessionId,
      prompt,
      executorConfig,
      latestCreatedAtMs(processes)
    );
    const { deferred, stopReal } = createStopReal(workspaceId, sessionId);
    const pendingState: PendingSend = {
      placeholder: pending,
      knownIds: new Set(processes.map((p) => p.id)),
      prompt: prompt.trim(),
      stopRequested: false,
      process: null,
      spawned: false,
      stopReal,
      settleOnAdopt: true,
      hideQueuedId: null,
      whenStopped: () => deferred.stop,
      onAbandoned: () => restorePrompt(sessionId, prompt, executorConfig),
    };
    pendingSends.set(sessionId, pendingState);
    pendingSendsChanged();
    addOptimisticProcess(pending);
    setLocalMessage('');
    clearUploadedAttachments();
    reviewContext?.clearComments();
    void clearDraft();
    const steering = steer(prompt, executorConfig);
    pendingState.steerRequest = steering.catch(() => undefined);
    try {
      const status = await steering;
      const row =
        status.status === 'queued'
          ? status.messages.find((m) => m.data.message === prompt)
          : undefined;
      if (row && pendingSends.get(sessionId) === pendingState) {
        pendingState.hideQueuedId = row.id;
        pendingSendsChanged();
      }
      // If the turn never shows up (the kill or the drain failed server-side),
      // don't leave a phantom turn behind; the queue list tells the truth.
      window.setTimeout(() => {
        if (pendingSends.get(sessionId) !== pendingState) return;
        if (pendingState.process) return;
        pendingSends.delete(sessionId);
        pendingSendsChanged();
        clearOptimisticProcess(pending.id);
        // Stop was pressed but no process ever showed up to kill: take the
        // message out of the queue so it doesn't run later unattended.
        // Captured session: the composer may show another one by now.
        if (pendingState.stopRequested) {
          if (pendingState.hideQueuedId) {
            void queueApi
              .cancelOne(sessionId, pendingState.hideQueuedId, hostId)
              .catch(logStopError);
          }
          void workspacesApi
            .stop(workspaceId, hostId, sessionId)
            .catch(logStopError);
        }
      }, 60_000);
    } catch (error) {
      // The steer never took effect, so the running turn is still going: a
      // stop pressed meanwhile has to reach it — unless this send has been
      // settled already and the session moved on.
      const current = pendingSends.get(sessionId) === pendingState;
      if (current && pendingState.stopRequested) stopReal(pending.id);
      if (current) pendingSends.delete(sessionId);
      pendingSendsChanged();
      clearOptimisticProcess(pending.id);
      restorePrompt(sessionId, prompt, executorConfig);
      void ErrorDialog.show({
        title: t('common:error'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    isAttemptRunning,
    handleSend,
    sessionId,
    workspaceId,
    localMessage,
    reviewMarkdown,
    executorConfig,
    processes,
    steer,
    cancelDebouncedSave,
    onScrollToBottom,
    setLocalMessage,
    clearUploadedAttachments,
    reviewContext,
    clearDraft,
    createStopReal,
    addOptimisticProcess,
    clearOptimisticProcess,
    hostId,
    restorePrompt,
    t,
  ]);

  // Remove a single queued message by id
  const handleRemoveQueued = useCallback(
    (messageId: string) => {
      if (isOptimisticQueuedId(messageId)) return;
      void cancelOne(messageId);
    },
    [cancelOne]
  );

  // "Send now" on an already-queued message: run it next, interrupting the
  // turn. Withheld while a follow-up send is pending: with no server process to
  // interrupt yet the backend would start a second, concurrent turn.
  const handleSteerQueued = useCallback(
    (messageId: string) => {
      if (isOptimisticQueuedId(messageId)) return;
      if (sessionId && pendingSends.has(sessionId)) return;
      void steerQueued(messageId);
    },
    [sessionId, steerQueued]
  );

  // Reorder the queue to a new id order (driven by the up/down arrows)
  const handleReorderQueued = useCallback(
    (messageIds: string[]) => {
      // A row the server hasn't acknowledged has no id it would accept.
      if (messageIds.some(isOptimisticQueuedId)) return;
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
    // An add still in flight would land after the clear and resurface.
    if (queuedMessages.some((m) => isOptimisticQueuedId(m.id))) return;
    await cancelQueue();
  }, [cancelQueue, queuedMessages]);

  const areAttachmentInputsDisabled =
    mode === 'placeholder' ||
    isCreatingSession ||
    !!feedbackContext?.isSubmitting ||
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
    if (!sessionId || !workspaceId) return;
    // Retry drops the edited turn and everything created at/after it, then
    // runs a new turn. Backend drops `created_at >= target`.
    const targetId = editContext.activeEdit.processId;
    const targetProcess = processes.find((p) => p.id === targetId);
    const idsToRemove =
      targetProcess != null
        ? processes
            .filter(
              (p) =>
                !p.dropped &&
                new Date(p.created_at as unknown as string).getTime() >=
                  new Date(
                    targetProcess.created_at as unknown as string
                  ).getTime()
            )
            .map((p) => p.id)
        : [targetId];
    // Ask for confirmation — the dialog fetches its own preflight data.
    let confirmation: RestoreLogsDialogResult | undefined;
    try {
      confirmation = await RestoreLogsDialog.show({
        executionProcessId: targetId,
        branchStatus,
        processes,
      });
    } catch {
      return;
    }
    if (!confirmation || confirmation.action !== 'confirmed') return;
    const prompt = localMessage;
    // Confirmed: reflect the drop and the new turn at once and leave edit
    // mode now; the server's reset + spawn follow. A refusal brings the
    // dropped turns back and puts the text in the composer.
    editContext.cancelEdit();
    cancelDebouncedSave();
    setLocalMessage('');
    idsToRemove.forEach((id) => removeOptimisticProcess(id));
    const { forceWhenDirty, performGitReset } = confirmation;
    await runPendingSend({
      target: sessionId,
      workspaceIdForStop: workspaceId,
      prompt,
      placeholder: createPendingProcess(
        sessionId,
        prompt,
        executorConfig,
        latestCreatedAtMs(processes)
      ),
      request: () =>
        sessionsApi.followUp(
          sessionId,
          {
            prompt,
            executor_config: executorConfig,
            retry_process_id: targetId,
            force_when_dirty: forceWhenDirty ?? false,
            perform_git_reset: performGitReset ?? true,
          },
          hostId
        ),
      onFailure: (error) => {
        idsToRemove.forEach((id) => clearOptimisticProcess(id));
        void ErrorDialog.show({
          title: t('common:error'),
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }, [
    editContext,
    localMessage,
    executorConfig,
    sessionId,
    workspaceId,
    hostId,
    branchStatus,
    processes,
    cancelDebouncedSave,
    setLocalMessage,
    removeOptimisticProcess,
    clearOptimisticProcess,
    runPendingSend,
    t,
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

    // Drop the approval UI at once; it comes back if the server refuses.
    resolveApprovalOptimistically(approvalId);
    try {
      await approveAsync({
        approvalId,
        executionProcessId: pendingApproval.executionProcessId,
      });

      // Invalidate workspace summary cache to update sidebar
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      onScrollToBottom();
    } catch (error) {
      unresolveApproval(approvalId);
      void ErrorDialog.show({
        title: t('common:error'),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    pendingApproval,
    feedbackContext,
    approveAsync,
    resolveApprovalOptimistically,
    unresolveApproval,
    queryClient,
    onScrollToBottom,
    t,
  ]);

  // Handle request changes (deny with feedback)
  const handleRequestChanges = useCallback(async () => {
    if (!pendingApproval || !localMessage.trim()) return;
    const approvalId = pendingApproval.approvalId;
    const reason = localMessage.trim();

    // Drop the approval UI at once: the composer switches back to the session
    // draft (the reason stays in the approval's own draft until the server
    // took it, so a refusal brings both the UI and the text back).
    resolveApprovalOptimistically(approvalId);
    try {
      await denyAsync({
        approvalId,
        executionProcessId: pendingApproval.executionProcessId,
        reason,
      });
      await clearDraft();

      // Invalidate workspace summary cache to update sidebar
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      onScrollToBottom();
    } catch {
      // The approval UI shows the mutation's error.
      unresolveApproval(approvalId);
    }
  }, [
    pendingApproval,
    localMessage,
    denyAsync,
    resolveApprovalOptimistically,
    unresolveApproval,
    clearDraft,
    queryClient,
    onScrollToBottom,
  ]);

  // Handle AskUserQuestion answer submission
  const handleAnswerQuestion = useCallback(
    async (answers: Array<{ question: string; answer: string[] }>) => {
      if (!pendingApproval) return;
      const approvalId = pendingApproval.approvalId;

      // Drop the question banner at once; it comes back with the mutation's
      // error (and the answers selected again) if the server refuses.
      delete refusedAnswersRef.current[approvalId];
      resolveApprovalOptimistically(approvalId);
      try {
        await answerAsync({
          approvalId,
          executionProcessId: pendingApproval.executionProcessId,
          answers,
        });
        queryClient.invalidateQueries({
          queryKey: workspaceSummaryKeys.all,
        });
        onScrollToBottom();
      } catch {
        refusedAnswersRef.current[approvalId] = answers;
        unresolveApproval(approvalId);
      }
    },
    [
      pendingApproval,
      answerAsync,
      resolveApprovalOptimistically,
      unresolveApproval,
      queryClient,
      onScrollToBottom,
    ]
  );

  // Check if approval is timed out
  const isApprovalTimedOut = pendingApproval
    ? new Date() > new Date(pendingApproval.timeoutAt)
    : false;

  // The pending-send registry is per session, so another conversation never
  // inherits this state; once the POST has returned the real (running) process
  // drives the status like any other turn.
  const status = computeExecutionStatus({
    isInFeedbackMode,
    isInEditMode: isInEditMode || editingQueuedId !== null,
    isStopping: isStopping || !!pendingSend?.stopRequested,
    isCreating: isCreatingSession,
    isSendingFollowUp: !!pendingSend && !pendingSend.process,
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
      onShiftCmdEnter,
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
        onShiftCmdEnter={onShiftCmdEnter}
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
      variant="ghost"
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
      queuedMessages={queuedMessages
        .filter((m) => m.id !== pendingSend?.hideQueuedId)
        .map((m) => ({
          id: m.id,
          message: m.data.message,
        }))}
      onRemoveQueued={handleRemoveQueued}
      onSteerQueued={pendingSend ? undefined : handleSteerQueued}
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
              disabled: isAttemptRunning || !!pendingSend,
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
              initialAnswers:
                refusedAnswersRef.current[pendingApproval.approvalId],
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
              isSubmitting: false,
              submitLabel: t('conversation.actions.confirmEdit'),
            }
          : {
              isActive: isInEditMode,
              onSubmitEdit: handleSubmitEdit,
              onCancel: handleCancelEdit,
              isSubmitting: false,
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
