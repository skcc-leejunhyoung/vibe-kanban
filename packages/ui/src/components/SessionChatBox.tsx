import {
  type ChangeEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type Icon,
  PaperclipIcon,
  CheckIcon,
  ClockIcon,
  XIcon,
  PlusIcon,
  SpinnerIcon,
  ChatCircleIcon,
  TrashIcon,
  WarningIcon,
  ArrowUpIcon,
  LightningIcon,
  ArrowsOutIcon,
  ArrowsClockwiseIcon,
  PencilSimpleIcon,
  DotsSixVerticalIcon,
  CaretDownIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from '@hello-pangea/dnd';
import { ChatBoxBase, VisualVariant, type DropzoneProps } from './ChatBoxBase';
import { type EditorProps, type ExecutorProps } from './CreateChatBox';
import type { AskUserQuestionItem, QuestionAnswer } from 'shared/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './Dropdown';
import { PrimaryButton } from './PrimaryButton';
import type { LocalAttachmentMetadata } from './WorkspaceContext';
import { ToolbarDropdown, ToolbarIconButton } from './Toolbar';
import { ContextUsageGauge, type ContextUsageInfo } from './ContextUsageGauge';
import { TodoProgressPopup, type TodoProgressItem } from './TodoProgressPopup';
import {
  AskUserQuestionBanner,
  type AskUserQuestionBannerHandle,
} from './AskUserQuestionBanner';
import {
  TurnNavigationPopup,
  type TurnNavigationItem,
} from './TurnNavigationPopup';
import { Tooltip } from './Tooltip';
import { cn } from '../lib/cn';
import { withDisplayTimeZone } from '../lib/datetime';

// Status enum - single source of truth for execution state
export type ExecutionStatus =
  | 'idle'
  | 'sending'
  | 'running'
  | 'stopping'
  | 'queue-loading'
  | 'feedback'
  | 'edit';

interface ActionsProps {
  onSend: () => void;
  onQueue: () => void;
  /** "Send now" / steer: interrupt the running turn and run this message now */
  onSteer: () => void;
  onCancelQueue: () => void;
  onStop: () => void;
  onPasteFiles: (files: File[]) => void;
  /** Start an automated `vibe` review session. When provided, a "review" button
   * is shown next to send while idle. */
  onVibeReview?: () => void;
  /** Run review and, after its merge completes, push the target branch and
   * create a draft pull request with AI-generated content. */
  onVibeReviewAndCreatePr?: () => void;
  /** True while a vibe review request is in flight; disables the review button
   * and shows a spinner so a double-click can't fire a second request. */
  isReviewing?: boolean;
}

/** A single queued follow-up message, shown in the queued-messages list. */
export interface QueuedMessageItem {
  id: string;
  message: string;
}

export interface SessionOption<TExecutor extends string = string> {
  id: string;
  name?: string | null;
  created_at: string | Date;
  updated_at?: string | Date;
  executor?: TExecutor | string | null;
}

interface SessionProps<TExecutor extends string = string> {
  sessions: SessionOption<TExecutor>[];
  selectedSessionId?: string;
  onSelectSession: (sessionId: string) => void;
  isNewSessionMode?: boolean;
  onNewSession?: () => void;
  onRenameSession?: (sessionId: string, currentName: string) => void;
  onDeleteSession?: (sessionId: string) => void;
}

export interface SessionToolbarActionItem {
  id: string;
  icon: Icon;
  label: string;
  tooltip?: string;
  onClick: () => void;
  disabled?: boolean;
}

interface ToolbarActionsProps {
  items: SessionToolbarActionItem[];
}

interface StatsProps {
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  hasConflicts?: boolean;
  conflictedFilesCount?: number;
  onResolveConflicts?: () => void;
}

interface FeedbackModeProps {
  isActive: boolean;
  onSubmitFeedback: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  error?: string | null;
  isTimedOut: boolean;
}

interface EditModeProps {
  isActive: boolean;
  onSubmitEdit: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  /** Submit button label; defaults to the retry label (sent-message edit). */
  submitLabel?: string;
}

interface ApprovalModeProps {
  isActive: boolean;
  onApprove: () => void;
  onRequestChanges: () => void;
  isSubmitting: boolean;
  isTimedOut: boolean;
  error?: string | null;
}

interface AskQuestionModeProps {
  isActive: boolean;
  questions: AskUserQuestionItem[];
  onSubmitAnswers: (answers: QuestionAnswer[]) => void;
  isSubmitting: boolean;
  isTimedOut: boolean;
  error?: string | null;
}

interface ReviewCommentsProps {
  /** Number of review comments */
  count: number;
  /** Preview markdown of the comments */
  previewMarkdown: string;
  /** Clear all comments */
  onClear: () => void;
}

interface AutoResumeProps {
  /** Whether usage-based auto-resume is enabled for this session */
  enabled: boolean;
  /** RFC3339 timestamp when a resume is scheduled, or null if none pending */
  pendingResumeAt?: string | null;
  /** Toggle auto-resume for this session */
  onToggle: (enabled: boolean) => void;
  /** Cancel a pending (scheduled) resume */
  onCancelPending?: () => void;
}

export interface SessionChatBoxEditorRenderProps<
  TExecutor extends string = string,
> {
  focusKey: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onCmdEnter: () => void;
  disabled: boolean;
  repoIds?: string[];
  executor: TExecutor | null;
  onPasteFiles: (files: File[]) => void;
  localAttachments?: LocalAttachmentMetadata[];
}

interface SessionChatBoxProps<TExecutor extends string = string> {
  status: ExecutionStatus;
  editor: EditorProps;
  renderEditor: (
    props: SessionChatBoxEditorRenderProps<TExecutor>
  ) => ReactNode;
  actions: ActionsProps;
  /** Messages queued to run after the current turn(s), oldest first */
  queuedMessages?: QueuedMessageItem[];
  /** Remove a single queued message by id */
  onRemoveQueued?: (id: string) => void;
  /** "Send now" on a queued message: run it next, interrupting the current turn */
  onSteerQueued?: (id: string) => void;
  /** Load a queued message into the input for in-place editing */
  onEditQueued?: (id: string) => void;
  /** Id of the queued message currently being edited (highlights its row) */
  editingQueuedId?: string | null;
  /** Reorder the queue to this exact id order (front first) */
  onReorderQueued?: (ids: string[]) => void;
  session: SessionProps<TExecutor>;
  stats?: StatsProps;
  feedbackMode?: FeedbackModeProps;
  editMode?: EditModeProps;
  approvalMode?: ApprovalModeProps;
  askQuestionMode?: AskQuestionModeProps;
  reviewComments?: ReviewCommentsProps;
  toolbarActions?: ToolbarActionsProps;
  handoff?: {
    current: TExecutor;
    selected: TExecutor | null;
    options: TExecutor[];
    onChange: (executor: TExecutor) => void;
    disabled?: boolean;
  };
  modelSelector?: ReactNode;
  error?: string | null;
  repoIds?: string[];
  agent?: TExecutor | null;
  executor?: ExecutorProps<TExecutor>;
  formatExecutorLabel?: (executor: TExecutor) => string;
  emptyExecutorLabel?: string;
  renderAgentIcon?: (
    executor: TExecutor | string | null | undefined,
    className?: string
  ) => ReactNode;
  formatSessionDate?: (createdAt: string | Date) => string;
  todos?: TodoProgressItem[];
  inProgressTodo?: TodoProgressItem | null;
  localAttachments?: LocalAttachmentMetadata[];
  onViewCode?: () => void;
  onOpenWorkspace?: () => void;
  onScrollToPreviousMessage?: () => void;
  userMessageTurns?: TurnNavigationItem[];
  onScrollToUserMessage?: (patchKey: string) => void;
  getActiveTurnPatchKey?: () => string | null;
  tokenUsageInfo?: ContextUsageInfo | null;
  supportsContextUsage?: boolean;
  autoResume?: AutoResumeProps;
  dropzone?: DropzoneProps;
  /**
   * Fill the height-bounded parent and let the editor area shrink (with internal
   * scroll) so the footer stays visible instead of the box growing tall enough
   * to cover the conversation. Requires a height-capped wrapper.
   */
  fillHeight?: boolean;
}

function defaultExecutorLabel(executor: string) {
  return executor
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function defaultFormatSessionDate(createdAt: string | Date) {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return String(createdAt);
  }

  return date.toLocaleString(
    undefined,
    withDisplayTimeZone({
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  );
}

/**
 * Full-featured chat box for session mode.
 * Supports queue, stop, attach, feedback mode, stats, and session switching.
 */
export function SessionChatBox<TExecutor extends string = string>({
  status,
  editor,
  renderEditor,
  actions,
  queuedMessages,
  onRemoveQueued,
  onSteerQueued,
  onEditQueued,
  editingQueuedId,
  onReorderQueued,
  session,
  stats,
  feedbackMode,
  editMode,
  approvalMode,
  askQuestionMode,
  reviewComments,
  toolbarActions,
  handoff,
  modelSelector,
  error,
  repoIds,
  agent,
  executor,
  formatExecutorLabel = defaultExecutorLabel,
  emptyExecutorLabel = 'Select Executor',
  renderAgentIcon,
  formatSessionDate = defaultFormatSessionDate,
  todos,
  inProgressTodo,
  localAttachments,
  onViewCode,
  onOpenWorkspace,
  onScrollToPreviousMessage,
  userMessageTurns,
  onScrollToUserMessage,
  getActiveTurnPatchKey,
  tokenUsageInfo,
  supportsContextUsage,
  autoResume,
  dropzone,
  fillHeight,
}: SessionChatBoxProps<TExecutor>) {
  const { t } = useTranslation('tasks');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const askQuestionBannerRef = useRef<AskUserQuestionBannerHandle>(null);

  // Determine if in feedback mode, edit mode, or approval mode
  const isInFeedbackMode = feedbackMode?.isActive ?? false;
  const isInEditMode = editMode?.isActive ?? false;
  const isInApprovalMode = approvalMode?.isActive ?? false;
  const isInAskQuestionMode = askQuestionMode?.isActive ?? false;

  // Key to force editor remount when entering feedback/edit/approval/question mode (triggers auto-focus)
  const focusKey = isInFeedbackMode
    ? 'feedback'
    : isInEditMode
      ? 'edit'
      : isInApprovalMode
        ? 'approval'
        : isInAskQuestionMode
          ? 'question'
          : 'normal';

  // Derived state from status
  const isDisabled = Boolean(
    status === 'sending' ||
      status === 'stopping' ||
      feedbackMode?.isSubmitting ||
      editMode?.isSubmitting ||
      approvalMode?.isSubmitting ||
      askQuestionMode?.isSubmitting
  );
  const hasContent =
    editor.value.trim().length > 0 || (reviewComments?.count ?? 0) > 0;
  const canSend =
    hasContent && !['sending', 'stopping', 'queue-loading'].includes(status);
  const isRunning = status === 'running';
  const areContentInsertActionsDisabled = isDisabled;
  const showRunningAnimation =
    (status === 'running' || status === 'sending') &&
    !isInApprovalMode &&
    !isInAskQuestionMode &&
    editor.value.trim().length === 0;

  const placeholder = isInFeedbackMode
    ? 'Provide feedback for the plan...'
    : isInEditMode
      ? 'Edit your message...'
      : isInApprovalMode
        ? 'Provide feedback to request changes...'
        : isInAskQuestionMode
          ? t('conversation.askQuestionPlaceholder')
          : session.isNewSessionMode
            ? 'Start a new conversation...'
            : 'Continue working on this task...';

  // Cmd+Enter handler
  const handleCmdEnter = () => {
    // AskUserQuestion mode: with text, submit it as a custom answer; with an
    // empty editor, confirm the banner's current selection instead.
    if (isInAskQuestionMode) {
      if (hasContent) {
        askQuestionBannerRef.current?.submitCustomAnswer(editor.value);
        editor.onChange('');
      } else {
        askQuestionBannerRef.current?.confirmSelection();
      }
      return;
    }
    // Approval mode: Cmd+Enter triggers approve or request changes based on input
    if (isInApprovalMode && !approvalMode?.isTimedOut) {
      if (canSend) {
        approvalMode?.onRequestChanges();
      } else {
        approvalMode?.onApprove();
      }
      return;
    }
    if (isInFeedbackMode && canSend && !feedbackMode?.isTimedOut) {
      feedbackMode?.onSubmitFeedback();
    } else if (isInEditMode && canSend) {
      editMode?.onSubmitEdit();
    } else if (status === 'running' && canSend) {
      actions.onQueue();
    } else if (status === 'idle' && canSend) {
      actions.onSend();
    }
  };

  // Reorder the queue when a drag-handle drop finishes, pushing the new order up.
  const handleQueueDragEnd = (result: DropResult) => {
    if (!onReorderQueued || !queuedMessages) return;
    const { source, destination } = result;
    if (!destination || source.index === destination.index) return;
    const ids = queuedMessages.map((m) => m.id);
    const [moved] = ids.splice(source.index, 1);
    ids.splice(destination.index, 0, moved);
    onReorderQueued(ids);
  };

  // File input handlers
  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      actions.onPasteFiles(files);
    }
    e.target.value = '';
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const {
    sessions,
    selectedSessionId,
    onSelectSession,
    isNewSessionMode,
    onNewSession,
    onRenameSession,
    onDeleteSession,
  } = session;
  const isLatestSelected =
    sessions.length > 0 && selectedSessionId === sessions[0].id;
  const selectedSessionObj = sessions.find((s) => s.id === selectedSessionId);
  const sessionLabel = isNewSessionMode
    ? t('conversation.sessions.newSession')
    : selectedSessionObj?.name
      ? selectedSessionObj.name
      : isLatestSelected
        ? t('conversation.sessions.latest')
        : t('conversation.sessions.previous');

  // Stats
  const filesChanged = stats?.filesChanged ?? 0;
  const linesAdded = stats?.linesAdded;
  const linesRemoved = stats?.linesRemoved;

  // Render action buttons based on status
  const renderActionButtons = () => {
    // Feedback mode takes precedence
    if (isInFeedbackMode) {
      if (feedbackMode?.isTimedOut) {
        return (
          <PrimaryButton
            variant="secondary"
            onClick={feedbackMode.onCancel}
            value={t('conversation.actions.cancel')}
          />
        );
      }
      return (
        <>
          <PrimaryButton
            variant="secondary"
            onClick={feedbackMode?.onCancel}
            value={t('conversation.actions.cancel')}
          />
          <PrimaryButton
            onClick={feedbackMode?.onSubmitFeedback}
            disabled={!canSend || feedbackMode?.isSubmitting}
            actionIcon={feedbackMode?.isSubmitting ? 'spinner' : undefined}
            value={t('conversation.actions.submitFeedback')}
          />
        </>
      );
    }

    // Edit mode
    if (isInEditMode) {
      return (
        <>
          <PrimaryButton
            variant="secondary"
            onClick={editMode?.onCancel}
            value={t('conversation.actions.cancel')}
          />
          <PrimaryButton
            onClick={editMode?.onSubmitEdit}
            disabled={!canSend || editMode?.isSubmitting}
            actionIcon={editMode?.isSubmitting ? 'spinner' : undefined}
            value={editMode?.submitLabel ?? t('conversation.retry')}
          />
        </>
      );
    }

    // Approval mode
    if (isInApprovalMode) {
      if (approvalMode?.isTimedOut) {
        return (
          <PrimaryButton
            variant="secondary"
            onClick={actions.onStop}
            value={t('conversation.actions.stop')}
          />
        );
      }

      const hasMessage = editor.value.trim().length > 0;

      return (
        <>
          <PrimaryButton
            variant="secondary"
            onClick={actions.onStop}
            value={t('conversation.actions.stop')}
          />
          {hasMessage ? (
            <PrimaryButton
              onClick={approvalMode?.onRequestChanges}
              disabled={approvalMode?.isSubmitting}
              actionIcon={approvalMode?.isSubmitting ? 'spinner' : undefined}
              value={t('conversation.actions.requestChanges')}
            />
          ) : (
            <PrimaryButton
              onClick={approvalMode?.onApprove}
              disabled={approvalMode?.isSubmitting}
              actionIcon={approvalMode?.isSubmitting ? 'spinner' : undefined}
              value={t('conversation.actions.approve')}
            />
          )}
        </>
      );
    }

    // AskUserQuestion mode
    if (isInAskQuestionMode) {
      if (askQuestionMode?.isTimedOut) {
        return (
          <PrimaryButton
            variant="secondary"
            onClick={actions.onStop}
            value={t('conversation.actions.stop')}
          />
        );
      }

      const hasMessage = editor.value.trim().length > 0;

      return (
        <>
          <PrimaryButton
            variant="secondary"
            onClick={actions.onStop}
            value={t('conversation.actions.stop')}
          />
          {hasMessage && (
            <PrimaryButton
              onClick={() => {
                askQuestionBannerRef.current?.submitCustomAnswer(editor.value);
                editor.onChange('');
              }}
              disabled={askQuestionMode?.isSubmitting}
              actionIcon={askQuestionMode?.isSubmitting ? 'spinner' : undefined}
              value={t('conversation.actions.send')}
            />
          )}
        </>
      );
    }

    switch (status) {
      case 'idle':
        return (
          <>
            {actions.onVibeReview && (
              <div className="flex">
                <PrimaryButton
                  variant="secondary"
                  onClick={actions.onVibeReview}
                  disabled={actions.isReviewing}
                  actionIcon={actions.isReviewing ? 'spinner' : undefined}
                  value={t('conversation.actions.review')}
                  className={
                    actions.onVibeReviewAndCreatePr
                      ? 'rounded-r-none'
                      : undefined
                  }
                />
                {actions.onVibeReviewAndCreatePr && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="min-h-cta rounded-sm rounded-l-none border-l border-on-brand/20 bg-brand-secondary px-half text-on-brand hover:bg-brand-hover disabled:cursor-not-allowed disabled:bg-panel"
                        disabled={actions.isReviewing}
                        aria-label={t(
                          'conversation.actions.reviewMore',
                          'More review actions'
                        )}
                      >
                        <CaretDownIcon className="size-icon-xs" weight="thin" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={actions.onVibeReviewAndCreatePr}
                      >
                        {t(
                          'conversation.actions.reviewAndCreatePr',
                          'Review and create PR from ai'
                        )}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            )}
            <PrimaryButton
              onClick={actions.onSend}
              disabled={!canSend}
              value={t('conversation.actions.send')}
            />
          </>
        );

      case 'sending':
        return (
          <PrimaryButton
            onClick={actions.onStop}
            actionIcon="spinner"
            value={t('conversation.actions.sending')}
          />
        );

      case 'running':
        return (
          <>
            <PrimaryButton
              onClick={actions.onStop}
              variant="secondary"
              value={t('conversation.actions.stop')}
              actionIcon="spinner"
            />
            <PrimaryButton
              onClick={actions.onSteer}
              disabled={!canSend}
              variant="secondary"
              value={t('conversation.actions.sendNow')}
            />
            <PrimaryButton
              onClick={actions.onQueue}
              disabled={!canSend}
              value={t('conversation.actions.queue')}
            />
          </>
        );

      case 'stopping':
        return (
          <PrimaryButton
            disabled
            value={t('conversation.actions.stopping')}
            actionIcon="spinner"
          />
        );
      case 'queue-loading':
        return (
          <PrimaryButton
            disabled
            value={t('conversation.actions.loading')}
            actionIcon="spinner"
          />
        );
      case 'feedback':
      case 'edit':
        return null;
    }
  };

  // Banner content
  const renderBanner = () => {
    const banners: ReactNode[] = [];

    // Review comments banner
    if (reviewComments && reviewComments.count > 0) {
      banners.push(
        <div
          key="review-comments"
          className="bg-accent/5 border-b px-double py-base flex items-center gap-base"
        >
          <ChatCircleIcon className="h-4 w-4 text-brand flex-shrink-0" />
          <span className="text-sm text-normal flex-1">
            {t('conversation.reviewComments.count', {
              count: reviewComments.count,
            })}
          </span>
          <button
            onClick={reviewComments.onClear}
            className="text-low hover:text-normal transition-colors p-1 -m-1"
            title={t('conversation.actions.clearReviewComments')}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      );
    }

    // AskUserQuestion banner (renders above input)
    if (isInAskQuestionMode && askQuestionMode) {
      banners.push(
        <AskUserQuestionBanner
          key="ask-question"
          ref={askQuestionBannerRef}
          questions={askQuestionMode.questions}
          onSubmitAnswers={askQuestionMode.onSubmitAnswers}
          isSubmitting={askQuestionMode.isSubmitting}
          isTimedOut={askQuestionMode.isTimedOut}
          error={askQuestionMode.error ?? null}
        />
      );
    }

    // Queued messages list — drained one at a time as each turn finishes.
    // Each row can be removed individually; "clear all" appears for 2+.
    // A left-edge handle lets you drag a row up or down to reorder the queue.
    if (queuedMessages && queuedMessages.length > 0) {
      const canReorder = !!onReorderQueued && queuedMessages.length > 1;
      banners.push(
        <div
          key="queued-list"
          className="bg-secondary border-b px-double py-base flex flex-col gap-half"
        >
          <div className="flex items-center gap-base">
            <ClockIcon className="h-4 w-4 text-low flex-shrink-0" />
            <span className="text-sm text-low flex-1">
              {t('followUp.queuedCount', { count: queuedMessages.length })}
            </span>
            {queuedMessages.length > 1 && (
              <button
                onClick={actions.onCancelQueue}
                className="text-xs text-low hover:text-normal transition-colors"
                title={t('conversation.actions.cancelQueue')}
              >
                {t('conversation.actions.cancelQueue')}
              </button>
            )}
          </div>
          <DragDropContext onDragEnd={handleQueueDragEnd}>
            <Droppable droppableId="queued-messages">
              {(dropProvided) => (
                <div
                  ref={dropProvided.innerRef}
                  {...dropProvided.droppableProps}
                  className="flex flex-col gap-half"
                >
                  {queuedMessages.map((queued, index) => (
                    <Draggable
                      key={queued.id}
                      draggableId={queued.id}
                      index={index}
                      isDragDisabled={!canReorder}
                    >
                      {(dragProvided, dragSnapshot) => (
                        <div
                          ref={dragProvided.innerRef}
                          {...dragProvided.draggableProps}
                          className={cn(
                            'flex items-center gap-base rounded-sm',
                            dragSnapshot.isDragging && 'bg-panel shadow-lg',
                            editingQueuedId === queued.id &&
                              'ring-1 ring-brand bg-brand/5'
                          )}
                        >
                          {/* Drag handle — grab here to reorder the queue.
                              Aligns under the header clock icon (both h-4 w-4),
                              so the row numbers line up with the count above. */}
                          <div
                            {...dragProvided.dragHandleProps}
                            className={cn(
                              'flex items-center flex-shrink-0',
                              canReorder
                                ? 'cursor-grab text-low hover:text-normal transition-colors'
                                : 'invisible'
                            )}
                            title={t('conversation.actions.reorderQueued')}
                            aria-label={t('conversation.actions.reorderQueued')}
                          >
                            <DotsSixVerticalIcon
                              className="h-4 w-4"
                              weight="bold"
                            />
                          </div>
                          <span className="text-xs text-low tabular-nums flex-shrink-0">
                            {index + 1}.
                          </span>
                          {/* Long messages are truncated to a single line with an ellipsis */}
                          <span className="text-sm text-normal flex-1 min-w-0 truncate">
                            {queued.message}
                          </span>
                          {onEditQueued && (
                            <button
                              type="button"
                              onClick={() => onEditQueued(queued.id)}
                              className="text-low hover:text-brand transition-colors p-1 -m-1 flex-shrink-0"
                              title={t('conversation.actions.edit')}
                              aria-label={t('conversation.actions.edit')}
                            >
                              <PencilSimpleIcon className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {onSteerQueued && (
                            <button
                              type="button"
                              onClick={() => onSteerQueued(queued.id)}
                              className="text-low hover:text-brand transition-colors p-1 -m-1 flex-shrink-0"
                              title={t('conversation.actions.sendNow')}
                              aria-label={t('conversation.actions.sendNow')}
                            >
                              <LightningIcon className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onRemoveQueued?.(queued.id)}
                            className="text-low hover:text-normal transition-colors p-1 -m-1 flex-shrink-0"
                            title={t('conversation.actions.removeQueued')}
                            aria-label={t('conversation.actions.removeQueued')}
                          >
                            <XIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {dropProvided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        </div>
      );
    }

    return banners.length > 0 ? <>{banners}</> : null;
  };

  // Combine errors
  const displayError =
    feedbackMode?.error ??
    approvalMode?.error ??
    askQuestionMode?.error ??
    error;

  // Determine visual variant
  const getVisualVariant = () => {
    if (isInFeedbackMode) return VisualVariant.FEEDBACK;
    if (isInEditMode) return VisualVariant.EDIT;
    if (isInApprovalMode || isInAskQuestionMode) return VisualVariant.PLAN;
    return VisualVariant.NORMAL;
  };

  return (
    <ChatBoxBase
      fillHeight={fillHeight}
      editor={renderEditor({
        focusKey,
        placeholder,
        value: editor.value,
        onChange: editor.onChange,
        onCmdEnter: handleCmdEnter,
        disabled: isDisabled,
        repoIds,
        executor: agent || executor?.selected || null,
        onPasteFiles: actions.onPasteFiles,
        localAttachments,
      })}
      error={displayError}
      banner={renderBanner()}
      visualVariant={getVisualVariant()}
      isRunning={showRunningAnimation}
      dropzone={dropzone}
      modelSelector={modelSelector}
      headerLeft={
        <>
          {/* New session mode: agent icon + executor dropdown */}
          {isNewSessionMode && executor && (
            <>
              {renderAgentIcon?.(agent, 'size-icon-xl')}
              <ToolbarDropdown
                label={
                  executor.selected
                    ? formatExecutorLabel(executor.selected)
                    : emptyExecutorLabel
                }
              >
                <DropdownMenuLabel>
                  {t('conversation.executors')}
                </DropdownMenuLabel>
                {executor.options.map((exec) => (
                  <DropdownMenuItem
                    key={exec}
                    icon={executor.selected === exec ? CheckIcon : undefined}
                    onClick={() => executor.onChange(exec)}
                  >
                    {formatExecutorLabel(exec)}
                  </DropdownMenuItem>
                ))}
              </ToolbarDropdown>
            </>
          )}
          {/* Existing session mode: show in-progress todo when running, otherwise file stats */}
          {!isNewSessionMode && (
            <>
              {isRunning && inProgressTodo ? (
                <span className="text-sm flex items-center gap-1 min-w-0">
                  <SpinnerIcon className="size-icon-sm animate-spin flex-shrink-0" />
                  <span className="truncate">{inProgressTodo.content}</span>
                </span>
              ) : (
                <>
                  {stats?.hasConflicts && (
                    <button
                      type="button"
                      className="flex items-center gap-1 text-warning text-sm min-w-0 cursor-pointer hover:underline"
                      title={t('conversation.approval.conflictWarning')}
                      onClick={stats.onResolveConflicts}
                    >
                      <WarningIcon className="size-icon-sm flex-shrink-0" />
                      <span className="truncate">
                        {t('conversation.approval.conflicts', {
                          count: stats.conflictedFilesCount,
                        })}
                      </span>
                    </button>
                  )}
                  {onOpenWorkspace ? (
                    <PrimaryButton
                      variant="secondary"
                      onClick={onOpenWorkspace}
                      value="Open Workspace"
                      actionIcon={ArrowsOutIcon}
                      className="min-w-0"
                    />
                  ) : onViewCode ? (
                    <PrimaryButton
                      variant="tertiary"
                      onClick={onViewCode}
                      className="min-w-0"
                    >
                      <span className="text-sm space-x-half whitespace-nowrap truncate">
                        <span>
                          {t('diff.filesChanged', { count: filesChanged })}
                        </span>
                        {(linesAdded !== undefined ||
                          linesRemoved !== undefined) && (
                          <span className="space-x-half">
                            {linesAdded !== undefined && (
                              <span className="text-success">
                                +{linesAdded}
                              </span>
                            )}
                            {linesRemoved !== undefined && (
                              <span className="text-error">
                                -{linesRemoved}
                              </span>
                            )}
                          </span>
                        )}
                      </span>
                    </PrimaryButton>
                  ) : (
                    <span className="text-sm text-low space-x-half whitespace-nowrap truncate min-w-0">
                      <span>
                        {t('diff.filesChanged', { count: filesChanged })}
                      </span>
                      {(linesAdded !== undefined ||
                        linesRemoved !== undefined) && (
                        <span className="space-x-half">
                          {linesAdded !== undefined && (
                            <span className="text-success">+{linesAdded}</span>
                          )}
                          {linesRemoved !== undefined && (
                            <span className="text-error">-{linesRemoved}</span>
                          )}
                        </span>
                      )}
                    </span>
                  )}
                </>
              )}
            </>
          )}
        </>
      }
      headerRight={
        <>
          {/* Turn navigation + Agent icon for existing session mode */}
          {!isNewSessionMode && (
            <>
              {onScrollToPreviousMessage && (
                <TurnNavigationPopup
                  turns={userMessageTurns ?? []}
                  onNavigateToTurn={onScrollToUserMessage ?? (() => {})}
                  getActiveTurnPatchKey={getActiveTurnPatchKey}
                >
                  <ToolbarIconButton
                    icon={ArrowUpIcon}
                    title={t('conversation.actions.scrollToPreviousMessage')}
                    aria-label={t(
                      'conversation.actions.scrollToPreviousMessage'
                    )}
                    onClick={onScrollToPreviousMessage}
                  />
                </TurnNavigationPopup>
              )}
              {handoff && handoff.options.length > 1 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center justify-center rounded-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-brand disabled:opacity-50"
                      aria-label={t('conversation.handoff.label')}
                      disabled={handoff.disabled}
                    >
                      {renderAgentIcon?.(agent, 'size-icon-xl')}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuLabel>
                      {t('conversation.handoff.target')}
                    </DropdownMenuLabel>
                    {handoff.options
                      .filter((executor) => executor !== handoff.current)
                      .map((executor) => (
                        <DropdownMenuItem
                          key={executor}
                          onClick={() => handoff.onChange(executor)}
                        >
                          <span className="flex items-center gap-base">
                            {handoff.selected === executor && (
                              <CheckIcon className="size-icon-sm" />
                            )}
                            {renderAgentIcon?.(executor, 'size-icon-sm')}
                            {formatExecutorLabel(executor)}
                          </span>
                        </DropdownMenuItem>
                      ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                renderAgentIcon?.(agent, 'size-icon-xl')
              )}
            </>
          )}
          {/* Todo progress popup - always rendered, disabled when no todos */}
          <TodoProgressPopup todos={todos ?? []} />
          {autoResume && !isNewSessionMode && (
            <AutoResumeControl {...autoResume} />
          )}
          {supportsContextUsage && (
            <ContextUsageGauge tokenUsageInfo={tokenUsageInfo} />
          )}
          <ToolbarDropdown
            label={sessionLabel}
            disabled={isInFeedbackMode || isInEditMode || isInApprovalMode}
            className="min-w-0 max-w-[120px]"
          >
            {/* New Session option */}
            <DropdownMenuItem
              icon={isNewSessionMode ? CheckIcon : PlusIcon}
              onClick={() => onNewSession?.()}
            >
              {t('conversation.sessions.newSession')}
            </DropdownMenuItem>
            {sessions.length > 0 && <DropdownMenuSeparator />}
            {sessions.length > 0 ? (
              <>
                <DropdownMenuLabel>
                  {t('conversation.sessions.label')}
                </DropdownMenuLabel>
                {sessions.map((s, index) => (
                  <DropdownMenuItem
                    key={s.id}
                    icon={
                      !isNewSessionMode && s.id === selectedSessionId
                        ? CheckIcon
                        : undefined
                    }
                    onClick={() => onSelectSession(s.id)}
                  >
                    <span className="flex items-center gap-1.5 max-w-[200px]">
                      {renderAgentIcon?.(
                        s.executor ?? null,
                        'size-icon shrink-0'
                      )}
                      <span className="truncate">
                        {s.name
                          ? s.name
                          : index === 0
                            ? t('conversation.sessions.latest')
                            : formatSessionDate(s.updated_at ?? s.created_at)}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </>
            ) : (
              <DropdownMenuItem disabled>
                {t('conversation.sessions.noPreviousSessions')}
              </DropdownMenuItem>
            )}
            {(onRenameSession || onDeleteSession) &&
              selectedSessionId &&
              !isNewSessionMode && <DropdownMenuSeparator />}
            {onRenameSession && selectedSessionId && !isNewSessionMode && (
              <DropdownMenuItem
                icon={PencilSimpleIcon}
                onClick={() =>
                  onRenameSession(
                    selectedSessionId,
                    selectedSessionObj?.name ?? ''
                  )
                }
              >
                {t('conversation.sessions.rename')}
              </DropdownMenuItem>
            )}
            {onDeleteSession && selectedSessionId && !isNewSessionMode && (
              <DropdownMenuItem
                icon={TrashIcon}
                variant="destructive"
                onClick={() => onDeleteSession(selectedSessionId)}
              >
                {t('conversation.sessions.delete')}
              </DropdownMenuItem>
            )}
          </ToolbarDropdown>
        </>
      }
      footerLeft={
        <>
          <ToolbarIconButton
            icon={PaperclipIcon}
            aria-label={t('tasks:taskFormDialog.attachFile')}
            title={t('tasks:taskFormDialog.attachFile')}
            onClick={handleAttachClick}
            disabled={areContentInsertActionsDisabled}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />
          {toolbarActions?.items.map((item) => (
            <ToolbarIconButton
              key={item.id}
              icon={item.icon}
              aria-label={item.label}
              title={item.tooltip}
              onClick={item.onClick}
              disabled={isDisabled || isRunning || Boolean(item.disabled)}
            />
          ))}
        </>
      }
      footerRight={renderActionButtons()}
    />
  );
}

function formatResetTime(date: Date) {
  return date.toLocaleTimeString(
    undefined,
    withDisplayTimeZone({
      hour: '2-digit',
      minute: '2-digit',
    })
  );
}

function formatCountdown(msRemaining: number) {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Per-session usage-based auto-resume control rendered in the chat header.
 * Shows a clickable icon button (brand color when on, muted when off) and,
 * when a resume is scheduled, a live countdown badge with a cancel button.
 */
function AutoResumeControl({
  enabled,
  pendingResumeAt,
  onToggle,
  onCancelPending,
}: AutoResumeProps) {
  const { t } = useTranslation('tasks');

  const resetDate = pendingResumeAt ? new Date(pendingResumeAt) : null;
  const isPending =
    !!resetDate && !Number.isNaN(resetDate.getTime()) && enabled;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isPending) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isPending]);

  if (isPending && resetDate) {
    const remaining = resetDate.getTime() - now;
    return (
      <div
        className={cn(
          'flex items-center gap-half rounded-sm border border-border',
          'bg-panel px-base py-half text-xs text-normal whitespace-nowrap'
        )}
      >
        <ArrowsClockwiseIcon className="size-icon-xs text-brand shrink-0" />
        <span>
          {t('conversation.autoResume.pending', {
            time: formatResetTime(resetDate),
          })}
        </span>
        <span className="font-ibm-plex-mono text-low">
          {formatCountdown(remaining)}
        </span>
        {onCancelPending && (
          <ToolbarIconButton
            icon={XIcon}
            className="ml-half"
            title={t('conversation.autoResume.cancel')}
            aria-label={t('conversation.autoResume.cancel')}
            onClick={onCancelPending}
          />
        )}
      </div>
    );
  }

  return (
    <Tooltip
      content={
        enabled
          ? t('conversation.autoResume.enabledTooltip')
          : t('conversation.autoResume.disabledTooltip')
      }
      side="bottom"
    >
      <button
        type="button"
        onClick={() => onToggle(!enabled)}
        aria-label={t('conversation.autoResume.toggleLabel')}
        aria-pressed={enabled}
        className="flex items-center cursor-pointer select-none p-1 -m-1"
      >
        <ArrowsClockwiseIcon
          className={cn(
            'size-icon-xs shrink-0 transition-colors',
            enabled ? 'text-brand' : 'text-low hover:text-normal'
          )}
        />
      </button>
    </Tooltip>
  );
}
