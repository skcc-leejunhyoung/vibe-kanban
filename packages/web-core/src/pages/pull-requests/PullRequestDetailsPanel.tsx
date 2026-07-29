import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowSquareOutIcon,
  GitPullRequestIcon,
  SpinnerGapIcon,
  XIcon,
} from '@phosphor-icons/react';
import { issuePrsApi } from '@/shared/lib/api';
import { usePrCommentsByUrl } from '@/shared/hooks/usePrComments';
import { buildPrConversation } from '@/shared/lib/prConversation';
import { useTheme } from '@/shared/hooks/useTheme';
import { getActualTheme } from '@/shared/lib/theme';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import { PrCommentCard } from '@vibe/ui/components/pr-comment-card';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { Button } from '@vibe/ui/components/Button';

interface PullRequestDetailsPanelProps {
  prUrl: string;
  prNumber: number;
  onClose: () => void;
}

export function PullRequestDetailsPanel({
  prUrl,
  prNumber,
  onClose,
}: PullRequestDetailsPanelProps) {
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
    staleTime: 30_000,
  });
  const commentsQuery = usePrCommentsByUrl(prUrl, prNumber, true);
  const comments = useMemo(
    () => commentsQuery.data?.comments ?? [],
    [commentsQuery.data?.comments]
  );
  const conversation = useMemo(
    () =>
      detailQuery.data ? buildPrConversation(detailQuery.data, comments) : [],
    [comments, detailQuery.data]
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const distance = Math.max(48, event.currentTarget.clientHeight * 0.12);
    event.currentTarget.scrollBy({
      top: event.key === 'ArrowDown' ? distance : -distance,
      behavior: 'smooth',
    });
  };

  const detail = detailQuery.data;
  useEffect(() => {
    scrollRef.current?.focus();
  }, [prUrl]);

  return (
    <aside className="flex h-full min-h-0 flex-col bg-secondary">
      <header className="flex shrink-0 items-center gap-base border-b border-border px-base py-base">
        <GitPullRequestIcon className="size-icon-base shrink-0" weight="bold" />
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-high">
          {detail?.title ?? `Pull Request #${prNumber}`}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-half text-low hover:bg-panel hover:text-high"
          aria-label="Close pull request details"
        >
          <XIcon className="size-icon-sm" />
        </button>
      </header>

      <div
        ref={scrollRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="min-h-0 flex-1 space-y-double overflow-y-auto p-double outline-none"
      >
        {detailQuery.isLoading && !detail ? (
          <div className="flex justify-center py-double">
            <SpinnerGapIcon className="size-icon-lg animate-spin" />
          </div>
        ) : detailQuery.isError ? (
          <p className="text-sm text-error">
            {detailQuery.error instanceof Error
              ? detailQuery.error.message
              : 'Failed to load pull request'}
          </p>
        ) : detail ? (
          <>
            <div className="flex flex-wrap items-center gap-half text-sm">
              <span className="rounded bg-panel px-base py-half capitalize">
                {detail.is_draft ? 'Draft' : detail.status}
              </span>
              <span className="break-all text-low">
                {detail.head_branch} → {detail.base_branch}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => openExternalUrl(prUrl)}
              >
                <ArrowSquareOutIcon />
                Open
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-base text-sm">
              <div className="rounded bg-panel p-base">
                <p className="text-xs text-low">Author</p>
                <p className="mt-half">{detail.author || 'Unknown'}</p>
              </div>
              <div className="rounded bg-panel p-base">
                <p className="text-xs text-low">Reviewers</p>
                <p className="mt-half">
                  {detail.reviewers.join(', ') || 'None'}
                </p>
              </div>
            </div>

            <section>
              <h3 className="mb-base text-sm font-semibold">Description</h3>
              {detail.body ? (
                <MarkdownPreview
                  content={detail.body}
                  theme={actualTheme}
                  className="min-w-0 overflow-hidden rounded bg-panel p-base [overflow-wrap:anywhere] break-words [&_pre]:whitespace-pre-wrap"
                />
              ) : (
                <p className="text-sm text-low">No description.</p>
              )}
            </section>

            <section>
              <h3 className="mb-base text-sm font-semibold">Conversation</h3>
              <div className="space-y-base">
                {conversation.map((item) =>
                  item.kind === 'comment' ? (
                    <PrCommentCard
                      key={item.key}
                      author={item.thread.comment.author}
                      body={item.thread.comment.body}
                      createdAt={item.thread.comment.created_at}
                      url={item.thread.comment.url}
                      commentType={item.thread.comment.comment_type}
                      variant="list"
                      className="bg-panel shadow-none"
                    />
                  ) : (
                    <div
                      key={item.key}
                      className="rounded border border-border bg-panel p-base text-sm"
                    >
                      {item.kind === 'commit'
                        ? `${item.commit.authors.join(', ') || 'Unknown'} committed ${item.commit.message}`
                        : item.kind === 'review'
                          ? `${item.review.author || 'Unknown'} ${item.review.state.toLowerCase().replaceAll('_', ' ')}`
                          : `${item.actor || 'Pull request'} ${item.action} this pull request`}
                    </div>
                  )
                )}
                {conversation.length === 0 && !commentsQuery.isLoading && (
                  <p className="text-sm text-low">No conversation activity.</p>
                )}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </aside>
  );
}
