import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { create, useModal } from '@ebay/nice-modal-react';
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CopyIcon,
  GitPullRequestIcon,
  SpinnerGapIcon,
  UserIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { defineModal } from '@/shared/lib/modals';
import { issuePrsApi } from '@/shared/lib/api';
import { usePrComments } from '@/shared/hooks/usePrComments';
import { usePrChatContextStore } from '@/shared/stores/usePrChatContextStore';
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
import { Checkbox } from '@vibe/ui/components/Checkbox';
import { PrCommentCard } from '@vibe/ui/components/pr-comment-card';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import type { UnifiedPrComment } from 'shared/types';

export interface PrDetailsDialogProps {
  /** Optional when opened from an issue without a local workspace. */
  workspaceId?: string;
  /** Optional when opened from an issue without a local repository. */
  repoId?: string;
  prUrl: string;
  prNumber: number;
}

function commentId(comment: UnifiedPrComment): string {
  return comment.id;
}

function commentsToMarkdown(comments: UnifiedPrComment[]): string {
  return comments
    .map((comment) => {
      const payload = {
        id: commentId(comment),
        comment_type: comment.comment_type,
        author: comment.author,
        body: comment.body,
        created_at: comment.created_at,
        url: comment.url,
        ...(comment.comment_type === 'review' && {
          path: comment.path,
          line: comment.line != null ? Number(comment.line) : null,
          diff_hunk: comment.diff_hunk,
        }),
      };
      return `\`\`\`gh-comment\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
    })
    .join('\n\n');
}

const PrDetailsDialogImpl = create<PrDetailsDialogProps>(
  ({ workspaceId, repoId, prUrl, prNumber }) => {
    const modal = useModal();
    const scrollRef = useRef<HTMLDivElement>(null);
    const { theme } = useTheme();
    const actualTheme = getActualTheme(theme);
    const addChatContext = usePrChatContextStore((state) => state.add);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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
    const commentsQuery = usePrComments(workspaceId, repoId, {
      enabled: modal.visible && !!workspaceId && !!repoId,
      prNumber,
    });
    const comments = useMemo(
      () => commentsQuery.data?.comments ?? [],
      [commentsQuery.data?.comments]
    );
    const close = () => {
      modal.resolve();
      modal.hide();
    };

    useEffect(() => {
      if (modal.visible) setSelectedIds(new Set());
    }, [modal.visible]);

    const toggleComment = (id: string) => {
      setSelectedIds((current) => {
        const next = new Set(current);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    };

    const handleAddToChat = () => {
      const selected = comments.filter((comment) =>
        selectedIds.has(commentId(comment))
      );
      if (selected.length === 0) return;
      if (!workspaceId) return;
      addChatContext(workspaceId, commentsToMarkdown(selected));
      close();
    };

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      const scroller = scrollRef.current;
      if (!scroller || event.defaultPrevented) return;
      const distance = Math.max(48, scroller.clientHeight * 0.12);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
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
        className="h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] max-w-3xl min-h-0 my-0 p-0 overflow-hidden"
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

                {detail.reviews.length > 0 && (
                  <section>
                    <h3 className="mb-base text-sm font-semibold">Reviews</h3>
                    <div className="flex flex-wrap gap-half">
                      {detail.reviews.map((review, index) => (
                        <span
                          key={`${review.author}-${index}`}
                          className="rounded bg-secondary px-base py-half text-sm"
                        >
                          {review.author}: {review.state.replaceAll('_', ' ')}
                        </span>
                      ))}
                    </div>
                  </section>
                )}
              </>
            ) : null}

            {workspaceId && repoId && (
              <section>
                <div className="mb-base flex items-center justify-between">
                  <h3 className="text-sm font-semibold">
                    Comments ({comments.length})
                  </h3>
                  {comments.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setSelectedIds(
                          selectedIds.size === comments.length
                            ? new Set()
                            : new Set(comments.map(commentId))
                        )
                      }
                    >
                      {selectedIds.size === comments.length
                        ? 'Deselect all'
                        : 'Select all'}
                    </Button>
                  )}
                </div>
                {commentsQuery.isError ? (
                  <p className="text-sm text-error">Failed to load comments.</p>
                ) : comments.length === 0 && !commentsQuery.isLoading ? (
                  <p className="text-sm text-low">No comments.</p>
                ) : (
                  <div className="space-y-base">
                    {comments.map((comment) => {
                      const id = commentId(comment);
                      return (
                        <div key={id} className="flex items-start gap-base">
                          <Checkbox
                            checked={selectedIds.has(id)}
                            onCheckedChange={() => toggleComment(id)}
                            className="mt-base"
                          />
                          <PrCommentCard
                            author={comment.author}
                            body={comment.body}
                            createdAt={comment.created_at}
                            url={comment.url}
                            commentType={comment.comment_type}
                            path={
                              comment.comment_type === 'review'
                                ? comment.path
                                : undefined
                            }
                            line={
                              comment.comment_type === 'review' &&
                              comment.line != null
                                ? Number(comment.line)
                                : undefined
                            }
                            diffHunk={
                              comment.comment_type === 'review'
                                ? comment.diff_hunk
                                : undefined
                            }
                            variant="list"
                            onClick={() => toggleComment(id)}
                            className="flex-1 min-w-0"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </div>

          <div className="shrink-0 flex justify-end gap-base border-t px-base py-base">
            <Button variant="outline" onClick={close}>
              Close
            </Button>
            {workspaceId && repoId && (
              <Button
                disabled={selectedIds.size === 0}
                onClick={handleAddToChat}
              >
                Add to chat
                {selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }
);

export const PrDetailsDialog = defineModal<PrDetailsDialogProps, void>(
  PrDetailsDialogImpl
);
