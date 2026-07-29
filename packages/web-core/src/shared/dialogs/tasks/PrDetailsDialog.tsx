import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { create, useModal } from '@ebay/nice-modal-react';
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CopyIcon,
  FileCodeIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ShieldCheckIcon,
  SpinnerGapIcon,
  UserIcon,
  UsersIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import { defineModal } from '@/shared/lib/modals';
import { issuePrsApi } from '@/shared/lib/api';
import {
  prCommentsKeys,
  usePrCommentsByUrl,
} from '@/shared/hooks/usePrComments';
import { useTheme } from '@/shared/hooks/useTheme';
import { getActualTheme } from '@/shared/lib/theme';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import { PrCommentCard } from '@vibe/ui/components/pr-comment-card';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import {
  buildPrConversation,
  type PrCommentThread,
} from '@/shared/lib/prConversation';

export interface PrDetailsDialogProps {
  prUrl: string;
  prNumber: number;
}

function formatActivityDate(value: string): string {
  return new Date(value).toLocaleString();
}

function ConversationComment({
  thread,
  theme,
  showLocation = true,
  depth = 0,
}: {
  thread: PrCommentThread;
  theme: 'light' | 'dark';
  showLocation?: boolean;
  depth?: number;
}) {
  const { comment, replies } = thread;
  const isReview = comment.comment_type === 'review';

  return (
    <div
      className={
        depth > 0 ? 'ml-double border-l-2 border-border pl-base pt-base' : ''
      }
    >
      <div className="flex min-w-0 items-start gap-base">
        <PrCommentCard
          author={comment.author}
          body={comment.body}
          bodyContent={
            <MarkdownPreview
              content={comment.body}
              theme={theme}
              className="min-w-0 overflow-hidden [overflow-wrap:anywhere] break-words [&_a]:break-all [&_pre]:max-w-full [&_pre]:whitespace-pre-wrap"
            />
          }
          createdAt={comment.created_at}
          url={comment.url}
          commentType={comment.comment_type}
          path={isReview && showLocation ? comment.path : undefined}
          line={
            isReview && comment.line != null ? Number(comment.line) : undefined
          }
          diffHunk={isReview ? comment.diff_hunk : undefined}
          variant="list"
          className={
            isReview
              ? 'min-w-0 flex-1 bg-primary shadow-none'
              : 'min-w-0 flex-1 bg-panel shadow-sm'
          }
        />
      </div>
      {replies.map((reply) => (
        <ConversationComment
          key={reply.comment.id}
          thread={reply}
          theme={theme}
          showLocation={false}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

function ReviewConversationThread({
  thread,
  theme,
  onSetResolved,
  isUpdating,
}: {
  thread: PrCommentThread;
  theme: 'light' | 'dark';
  onSetResolved?: (threadId: string, resolved: boolean) => void;
  isUpdating: boolean;
}) {
  const comment = thread.comment;
  const isReview = comment.comment_type === 'review';
  const resolved = isReview && comment.is_resolved === true;
  const [expanded, setExpanded] = useState(!resolved);

  useEffect(() => {
    if (resolved) setExpanded(false);
  }, [resolved]);

  if (!isReview) {
    return <ConversationComment thread={thread} theme={theme} />;
  }

  return (
    <div className="min-w-0 overflow-hidden rounded border border-border bg-panel shadow-sm">
      <div className="flex min-w-0 items-center gap-half bg-secondary px-base py-base">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-half text-left"
          aria-expanded={expanded}
        >
          {expanded ? (
            <CaretDownIcon className="size-icon-xs shrink-0" weight="bold" />
          ) : (
            <CaretRightIcon className="size-icon-xs shrink-0" weight="bold" />
          )}
          <FileCodeIcon className="size-icon-sm shrink-0 text-low" />
          <code className="min-w-0 truncate text-xs">
            {comment.path}
            {comment.line != null ? `:${Number(comment.line)}` : ''}
          </code>
          {comment.is_outdated && (
            <span className="shrink-0 rounded bg-panel px-half py-px text-xs text-low">
              Outdated
            </span>
          )}
          {resolved && (
            <span className="inline-flex shrink-0 items-center gap-half rounded bg-success/10 px-half py-px text-xs text-success">
              <CheckCircleIcon className="size-icon-xs" weight="fill" />
              Resolved
            </span>
          )}
          {!expanded && (
            <span className="ml-auto shrink-0 text-xs text-low">
              {thread.replies.length + 1}{' '}
              {thread.replies.length === 0 ? 'comment' : 'comments'}
            </span>
          )}
        </button>
      </div>
      {expanded && (
        <div className="border-t p-base">
          <ConversationComment
            thread={thread}
            theme={theme}
            showLocation={false}
          />
        </div>
      )}
      {comment.thread_id && comment.is_resolved != null && onSetResolved && (
        <div className="flex justify-end border-t bg-secondary/50 px-base py-half">
          <Button
            variant="ghost"
            size="sm"
            disabled={isUpdating}
            onClick={() =>
              onSetResolved(comment.thread_id!, !comment.is_resolved)
            }
            className="shrink-0"
          >
            {isUpdating && (
              <SpinnerGapIcon className="size-icon-xs animate-spin" />
            )}
            {resolved ? 'Unresolve' : 'Resolve conversation'}
          </Button>
        </div>
      )}
    </div>
  );
}

const PrDetailsDialogImpl = create<PrDetailsDialogProps>(
  ({ prUrl, prNumber }) => {
    const modal = useModal();
    const queryClient = useQueryClient();
    const scrollRef = useRef<HTMLDivElement>(null);
    const { theme } = useTheme();
    const actualTheme = getActualTheme(theme);
    const detailQuery = useQuery({
      queryKey: ['pr-detail', prUrl],
      queryFn: async () => {
        const result = await issuePrsApi.getPrInfo(prUrl);
        if (!result.success) {
          throw new Error(result.message || 'Failed to load pull request');
        }
        return result.data;
      },
      enabled: modal.visible,
      staleTime: 30_000,
    });
    const commentsQuery = usePrCommentsByUrl(prUrl, prNumber, modal.visible);
    const comments = useMemo(
      () => commentsQuery.data?.comments ?? [],
      [commentsQuery.data?.comments]
    );
    const conversation = useMemo(
      () =>
        detailQuery.data ? buildPrConversation(detailQuery.data, comments) : [],
      [comments, detailQuery.data]
    );
    const resolveThreadMutation = useMutation({
      mutationFn: ({
        threadId,
        resolved,
      }: {
        threadId: string;
        resolved: boolean;
      }) =>
        issuePrsApi.setPrReviewThreadResolved(
          prUrl,
          prNumber,
          threadId,
          resolved
        ),
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: prCommentsKeys.byUrl(prUrl, prNumber),
        }),
    });
    const close = () => {
      modal.resolve();
      modal.hide();
    };

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      const scroller = scrollRef.current;
      if (!scroller || event.defaultPrevented) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (event.metaKey || event.ctrlKey) {
          scroller.scrollTo({
            top: event.key === 'ArrowDown' ? scroller.scrollHeight : 0,
            behavior: 'smooth',
          });
          return;
        }
        const distance = Math.max(48, scroller.clientHeight * 0.12);
        scroller.scrollBy({
          top: event.key === 'ArrowDown' ? distance : -distance,
          behavior: 'smooth',
        });
      }
    };

    const detail = detailQuery.data;
    const loading = detailQuery.isLoading || commentsQuery.isLoading;

    return (
      <Dialog
        open={modal.visible}
        onOpenChange={(open) => !open && close()}
        onKeyDownCapture={handleDialogKeyDown}
        className="h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none min-h-0 my-0 p-0 overflow-hidden"
      >
        <DialogContent className="min-h-0 flex-1 gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-base py-base border-b">
            <DialogTitle className="flex items-center gap-base min-w-0">
              <GitPullRequestIcon className="size-icon-lg shrink-0" />
              <span className="truncate">
                {detail?.title || `Pull Request #${prNumber}`}
              </span>
            </DialogTitle>
          </DialogHeader>

          <div
            ref={scrollRef}
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-double space-y-double"
          >
            {loading && !detail ? (
              <div className="flex justify-center py-double">
                <SpinnerGapIcon className="size-icon-lg animate-spin" />
              </div>
            ) : detailQuery.isError ? (
              <p className="text-error">
                {detailQuery.error instanceof Error
                  ? detailQuery.error.message
                  : 'Failed to load pull request'}
              </p>
            ) : detail ? (
              <>
                <div className="flex flex-wrap items-center gap-base">
                  <span className="inline-flex items-center gap-half rounded bg-panel px-base py-half text-sm">
                    {detail.status === 'merged' ? (
                      <CheckCircleIcon className="text-success" weight="fill" />
                    ) : (
                      <GitPullRequestIcon
                        className="text-normal"
                        weight="fill"
                      />
                    )}
                    {detail.is_draft ? 'Draft' : detail.status}
                  </span>
                  <span className="min-w-0 break-all text-sm text-low">
                    {detail.head_branch} → {detail.base_branch}
                  </span>
                  {detail.review_decision && (
                    <span className="rounded bg-panel px-base py-half text-sm">
                      {detail.review_decision.replaceAll('_', ' ')}
                    </span>
                  )}
                  <div className="ml-auto flex gap-half">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigator.clipboard?.writeText(prUrl)}
                    >
                      <CopyIcon /> Copy URL
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openExternalUrl(prUrl)}
                    >
                      <ArrowSquareOutIcon /> Open
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-base">
                  <div className="rounded bg-secondary p-base">
                    <div className="flex items-center gap-half text-xs text-low">
                      <UserIcon /> Author
                    </div>
                    <div className="mt-half text-sm">
                      {detail.author || 'Unknown'}
                    </div>
                  </div>
                  <div className="rounded bg-secondary p-base">
                    <div className="flex items-center gap-half text-xs text-low">
                      <UserIcon /> Assignees
                    </div>
                    <div className="mt-half text-sm">
                      {detail.assignees.join(', ') || 'None'}
                    </div>
                  </div>
                  <div className="rounded bg-secondary p-base">
                    <div className="flex items-center gap-half text-xs text-low">
                      <UsersIcon /> Reviewers
                    </div>
                    <div className="mt-half text-sm">
                      {detail.reviewers.join(', ') || 'None'}
                    </div>
                  </div>
                </div>

                <section className="min-w-0 overflow-hidden">
                  <h3 className="mb-base text-sm font-semibold">Description</h3>
                  {detail.body ? (
                    <MarkdownPreview
                      content={detail.body}
                      theme={actualTheme}
                      className="min-w-0 max-w-full overflow-hidden rounded bg-secondary p-base [overflow-wrap:anywhere] break-words [&_a]:break-all [&_p]:break-words [&_pre]:max-w-full [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_table]:max-w-full"
                    />
                  ) : (
                    <p className="text-sm text-low">No description.</p>
                  )}
                </section>

                <section className="min-w-0">
                  <h3 className="mb-base text-sm font-semibold">
                    Conversation
                  </h3>
                  {commentsQuery.isError && (
                    <p className="mb-base text-sm text-error">
                      Some conversation comments could not be loaded.
                    </p>
                  )}
                  {resolveThreadMutation.isError && (
                    <p className="mb-base text-sm text-error">
                      {resolveThreadMutation.error instanceof Error
                        ? resolveThreadMutation.error.message
                        : 'Failed to update conversation.'}
                    </p>
                  )}
                  <div className="relative space-y-base before:absolute before:bottom-base before:left-[15px] before:top-base before:w-px before:bg-border">
                    {conversation.map((item) => {
                      if (item.kind === 'comment') {
                        return (
                          <div
                            key={item.key}
                            className="relative pl-[42px] before:absolute before:left-[7px] before:top-base before:z-10 before:size-[17px] before:rounded-full before:border-4 before:border-panel before:bg-brand"
                          >
                            <ReviewConversationThread
                              thread={item.thread}
                              theme={actualTheme}
                              onSetResolved={(threadId, resolved) =>
                                resolveThreadMutation.mutate({
                                  threadId,
                                  resolved,
                                })
                              }
                              isUpdating={
                                resolveThreadMutation.isPending &&
                                resolveThreadMutation.variables?.threadId ===
                                  (item.thread.comment.comment_type === 'review'
                                    ? item.thread.comment.thread_id
                                    : undefined)
                              }
                            />
                          </div>
                        );
                      }

                      const Icon =
                        item.kind === 'commit'
                          ? GitCommitIcon
                          : item.kind === 'review'
                            ? ShieldCheckIcon
                            : item.action === 'merged'
                              ? GitMergeIcon
                              : item.action === 'closed'
                                ? XCircleIcon
                                : GitPullRequestIcon;
                      return (
                        <div
                          key={item.key}
                          className="relative flex min-w-0 items-start gap-base py-half pl-[42px] text-low"
                        >
                          <span className="absolute left-[4px] top-half z-10 flex size-[23px] items-center justify-center rounded-full border border-border bg-secondary">
                            <Icon className="size-icon-xs" />
                          </span>
                          <div className="min-w-0 flex-1 px-base py-half text-sm">
                            {item.kind === 'commit' ? (
                              <div className="flex min-w-0 flex-wrap items-center gap-half">
                                <span className="font-medium text-normal">
                                  {item.commit.authors.join(', ') ||
                                    'Unknown author'}
                                </span>
                                <span className="text-low">committed</span>
                                <span className="min-w-0 break-words text-normal">
                                  {item.commit.message}
                                </span>
                                <code className="ml-auto text-xs text-low">
                                  {item.commit.oid.slice(0, 7)}
                                </code>
                              </div>
                            ) : item.kind === 'review' ? (
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-half">
                                  <span className="font-medium text-normal">
                                    {item.review.author || 'Unknown reviewer'}
                                  </span>
                                  <span className="text-low">
                                    {item.review.state
                                      .toLowerCase()
                                      .replaceAll('_', ' ')}
                                  </span>
                                </div>
                                {item.review.body && (
                                  <MarkdownPreview
                                    content={item.review.body}
                                    theme={actualTheme}
                                    className="mt-base min-w-0 overflow-hidden [overflow-wrap:anywhere] break-words"
                                  />
                                )}
                              </div>
                            ) : (
                              <div>
                                <span className="font-medium text-normal">
                                  {item.actor || 'Pull request'}
                                </span>{' '}
                                <span className="text-low">
                                  {item.action} this pull request
                                </span>
                              </div>
                            )}
                            <div className="mt-half text-xs text-low">
                              {formatActivityDate(item.createdAt)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {conversation.length === 0 && !commentsQuery.isLoading && (
                      <p className="pl-[42px] text-sm text-low">
                        No conversation activity.
                      </p>
                    )}
                  </div>
                </section>
              </>
            ) : null}
          </div>

          <div className="shrink-0 flex justify-end gap-base border-t px-base py-base">
            <Button variant="outline" onClick={close}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }
);

export const PrDetailsDialog = defineModal<PrDetailsDialogProps, void>(
  PrDetailsDialogImpl
);
