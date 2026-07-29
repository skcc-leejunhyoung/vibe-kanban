import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowClockwiseIcon,
  ChatCircleIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react';
import { repoApi } from '@/shared/lib/api';
import { PrDetailsDialog } from '@/shared/dialogs/tasks/PrDetailsDialog';
import { cn } from '@/shared/lib/utils';
import type { MergeStatus } from 'shared/types';

type StatusFilter = 'all' | MergeStatus;
type DraftFilter = 'all' | 'draft' | 'ready';
type UpdatedFilter = 'all' | 'day' | 'week' | 'month';

const selectClassName =
  'h-9 rounded border border-border bg-secondary px-base text-sm text-normal focus:outline-none focus:ring-1 focus:ring-brand';

function statusLabel(status: MergeStatus): string {
  if (status === 'open') return 'Open';
  if (status === 'merged') return 'Merged';
  if (status === 'closed') return 'Closed';
  return 'Unknown';
}

function statusIcon(status: MergeStatus) {
  if (status === 'merged') {
    return <GitMergeIcon className="size-icon-base text-brand" weight="bold" />;
  }
  return (
    <GitPullRequestIcon
      className={cn(
        'size-icon-base',
        status === 'open' ? 'text-success' : 'text-low'
      )}
      weight="bold"
    />
  );
}

function matchesUpdatedFilter(
  updatedAt: string | null,
  filter: UpdatedFilter
): boolean {
  if (filter === 'all') return true;
  if (!updatedAt) return false;
  const days = filter === 'day' ? 1 : filter === 'week' ? 7 : 30;
  return Date.now() - new Date(updatedAt).getTime() <= days * 86_400_000;
}

export function PullRequestsPage() {
  const [query, setQuery] = useState('');
  const [repository, setRepository] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [author, setAuthor] = useState('all');
  const [draft, setDraft] = useState<DraftFilter>('all');
  const [updated, setUpdated] = useState<UpdatedFilter>('all');

  const pullRequestsQuery = useQuery({
    queryKey: ['involved-pull-requests'],
    queryFn: async () => {
      const result = await repoApi.listInvolvedPrs();
      if (!result.success) {
        throw new Error(result.message || 'Failed to load pull requests');
      }
      return result.data;
    },
    staleTime: 30_000,
  });

  const pullRequests = useMemo(
    () => pullRequestsQuery.data ?? [],
    [pullRequestsQuery.data]
  );
  const repositories = useMemo(
    () =>
      [...new Set(pullRequests.map((pr) => pr.repository))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [pullRequests]
  );
  const authors = useMemo(
    () =>
      [
        ...new Set(
          pullRequests
            .map((pr) => pr.author)
            .filter((name): name is string => name !== null)
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [pullRequests]
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredPullRequests = useMemo(
    () =>
      pullRequests.filter((pr) => {
        if (repository !== 'all' && pr.repository !== repository) return false;
        if (status !== 'all' && pr.status !== status) return false;
        if (author !== 'all' && pr.author !== author) return false;
        if (draft === 'draft' && !pr.is_draft) return false;
        if (draft === 'ready' && pr.is_draft) return false;
        if (!matchesUpdatedFilter(pr.updated_at, updated)) return false;
        if (!normalizedQuery) return true;

        return [
          pr.title,
          pr.body,
          pr.repository,
          pr.author ?? '',
          String(pr.number),
          ...pr.assignees,
          ...pr.labels,
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      }),
    [draft, author, normalizedQuery, pullRequests, repository, status, updated]
  );

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border px-double py-base">
        <div className="flex items-center justify-between gap-base">
          <div>
            <h1 className="text-xl font-semibold text-high">Pull Requests</h1>
            <p className="mt-half text-sm text-low">
              Pull requests involving you on GitHub
            </p>
          </div>
          <button
            type="button"
            onClick={() => void pullRequestsQuery.refetch()}
            disabled={pullRequestsQuery.isFetching}
            className="flex h-9 items-center gap-half rounded border border-border bg-secondary px-base text-sm text-normal hover:text-high disabled:opacity-50"
          >
            <ArrowClockwiseIcon
              className={cn(
                'size-icon-sm',
                pullRequestsQuery.isFetching && 'animate-spin'
              )}
            />
            Refresh
          </button>
        </div>

        <div className="mt-base grid grid-cols-2 gap-half md:grid-cols-3 xl:grid-cols-[minmax(220px,1fr)_repeat(5,minmax(120px,auto))]">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, repository, author, label…"
            className="h-9 rounded border border-border bg-secondary px-base text-sm text-normal placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
          />
          <select
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            className={selectClassName}
            aria-label="Repository"
          >
            <option value="all">All repositories</option>
            {repositories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
            className={selectClassName}
            aria-label="Status"
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="merged">Merged</option>
            <option value="closed">Closed</option>
          </select>
          <select
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
            className={selectClassName}
            aria-label="Author"
          >
            <option value="all">All authors</option>
            {authors.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={draft}
            onChange={(event) => setDraft(event.target.value as DraftFilter)}
            className={selectClassName}
            aria-label="Draft status"
          >
            <option value="all">Draft or ready</option>
            <option value="draft">Draft</option>
            <option value="ready">Ready for review</option>
          </select>
          <select
            value={updated}
            onChange={(event) =>
              setUpdated(event.target.value as UpdatedFilter)
            }
            className={selectClassName}
            aria-label="Updated"
          >
            <option value="all">Updated anytime</option>
            <option value="day">Last 24 hours</option>
            <option value="week">Last 7 days</option>
            <option value="month">Last 30 days</option>
          </select>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {pullRequestsQuery.isLoading ? (
          <div className="flex h-full items-center justify-center gap-half text-low">
            <SpinnerGapIcon className="size-icon-base animate-spin" />
            Loading pull requests…
          </div>
        ) : pullRequestsQuery.isError ? (
          <div className="flex h-full flex-col items-center justify-center px-double text-center">
            <GitPullRequestIcon className="size-8 text-low" />
            <p className="mt-base text-base font-medium text-high">
              Could not load pull requests
            </p>
            <p className="mt-half max-w-lg text-sm text-low">
              {pullRequestsQuery.error.message}
            </p>
          </div>
        ) : filteredPullRequests.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-low">
            <GitPullRequestIcon className="size-8" />
            <p className="mt-base text-sm">
              No pull requests match the filters.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredPullRequests.map((pr) => (
              <button
                type="button"
                key={pr.url}
                onClick={() =>
                  void PrDetailsDialog.show({
                    prUrl: pr.url,
                    prNumber: Number(pr.number),
                  })
                }
                className="flex w-full items-start gap-base px-double py-base text-left hover:bg-secondary/60"
              >
                <span className="mt-half">{statusIcon(pr.status)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-half">
                    <span className="truncate text-base font-medium text-high">
                      {pr.title}
                    </span>
                    {pr.is_draft && (
                      <span className="rounded bg-secondary px-half py-0.5 text-xs text-low">
                        Draft
                      </span>
                    )}
                    {pr.labels.map((label) => (
                      <span
                        key={label}
                        className="rounded border border-border px-half py-0.5 text-xs text-low"
                      >
                        {label}
                      </span>
                    ))}
                  </span>
                  <span className="mt-half flex flex-wrap items-center gap-x-base gap-y-half text-sm text-low">
                    <span>
                      {pr.repository} #{String(pr.number)}
                    </span>
                    <span>{statusLabel(pr.status)}</span>
                    <span>by {pr.author ?? 'unknown'}</span>
                    {pr.updated_at && (
                      <span>
                        updated {new Date(pr.updated_at).toLocaleDateString()}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <ChatCircleIcon className="size-icon-xs" />
                      {String(pr.comments_count)}
                    </span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
