import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  ArrowClockwiseIcon,
  ChatCircleIcon,
  FunnelIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  MagnifyingGlassIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react';
import { repoApi } from '@/shared/lib/api';
import { cn } from '@/shared/lib/utils';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { PullRequestDetailsPanel } from './PullRequestDetailsPanel';
import { PullRequestFiltersDialog } from './PullRequestFiltersDialog';
import {
  PULL_REQUESTS_FOCUS_SEARCH_EVENT,
  PULL_REQUESTS_OPEN_FILTERS_EVENT,
  type PullRequestFilterState,
  type PullRequestUpdatedFilter,
} from './pullRequestFilters';
import type { MergeStatus, PullRequestSummary } from 'shared/types';

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
  filter: PullRequestUpdatedFilter
): boolean {
  if (filter === 'all') return true;
  if (!updatedAt) return false;
  const days = filter === 'day' ? 1 : filter === 'week' ? 7 : 30;
  return Date.now() - new Date(updatedAt).getTime() <= days * 86_400_000;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function activeFilterCount(filters: PullRequestFilterState): number {
  return [
    filters.repository !== 'all',
    filters.status !== 'all',
    filters.author !== 'all',
    filters.draft !== 'all',
    filters.updated !== 'all',
    filters.involvesMe,
  ].filter(Boolean).length;
}

export function PullRequestsPage() {
  const defaultFilters = useUiPreferencesStore(
    (state) => state.pullRequestDefaultFilters
  );
  const [filters, setFilters] = useState<PullRequestFilterState>(() => ({
    ...defaultFilters,
  }));
  const [query, setQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedPullRequest, setSelectedPullRequest] =
    useState<PullRequestSummary | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const pullRequestsQuery = useQuery({
    queryKey: ['pull-request-summaries', filters.involvesMe],
    queryFn: async () => {
      const result = await repoApi.listPullRequestSummaries(filters.involvesMe);
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
        if (
          filters.repository !== 'all' &&
          pr.repository !== filters.repository
        ) {
          return false;
        }
        if (filters.status !== 'all' && pr.status !== filters.status) {
          return false;
        }
        if (filters.author !== 'all' && pr.author !== filters.author) {
          return false;
        }
        if (filters.draft === 'draft' && !pr.is_draft) return false;
        if (filters.draft === 'ready' && pr.is_draft) return false;
        if (!matchesUpdatedFilter(pr.updated_at, filters.updated)) return false;
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
    [filters, normalizedQuery, pullRequests]
  );

  useEffect(() => {
    setSelectedIndex((current) =>
      Math.min(current, Math.max(0, filteredPullRequests.length - 1))
    );
  }, [filteredPullRequests.length]);

  useEffect(() => {
    const openFilters = () => setFiltersOpen(true);
    const focusSearch = () => searchInputRef.current?.focus();
    window.addEventListener(PULL_REQUESTS_OPEN_FILTERS_EVENT, openFilters);
    window.addEventListener(PULL_REQUESTS_FOCUS_SEARCH_EVENT, focusSearch);
    return () => {
      window.removeEventListener(PULL_REQUESTS_OPEN_FILTERS_EVENT, openFilters);
      window.removeEventListener(PULL_REQUESTS_FOCUS_SEARCH_EVENT, focusSearch);
    };
  }, []);

  const focusRow = useCallback(
    (index: number) => {
      const pullRequest = filteredPullRequests[index];
      if (!pullRequest) return;
      const row = rowRefs.current.get(pullRequest.url);
      row?.focus();
      row?.scrollIntoView({ block: 'nearest' });
    },
    [filteredPullRequests]
  );

  const closeDetails = useCallback(() => {
    setSelectedPullRequest(null);
    window.requestAnimationFrame(() => focusRow(selectedIndex));
  }, [focusRow, selectedIndex]);

  useEffect(() => {
    if (!selectedPullRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeDetails();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [closeDetails, selectedPullRequest]);

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (
      selectedPullRequest ||
      isEditableTarget(event.target) ||
      filteredPullRequests.length === 0
    ) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = Math.min(
        filteredPullRequests.length - 1,
        Math.max(0, selectedIndex + direction)
      );
      setSelectedIndex(nextIndex);
      focusRow(nextIndex);
    } else if (event.key === 'Enter') {
      const pullRequest = filteredPullRequests[selectedIndex];
      if (pullRequest) {
        event.preventDefault();
        setSelectedPullRequest(pullRequest);
      }
    }
  };

  const listContent = (
    <main
      className="flex h-full min-h-0 flex-col overflow-hidden"
      onKeyDown={handleListKeyDown}
    >
      <header className="shrink-0 border-b border-border px-double py-base">
        <div className="flex items-center justify-between gap-base">
          <div>
            <h1 className="text-xl font-semibold text-high">Pull Requests</h1>
            <p className="mt-half text-sm text-low">
              {filters.involvesMe
                ? 'Pull requests involving you on GitHub'
                : 'Recent pull requests on GitHub'}
            </p>
          </div>
          <div className="flex items-center gap-half">
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              className="relative flex size-9 items-center justify-center rounded border border-border bg-secondary text-normal hover:text-high"
              aria-label="Filter pull requests"
              title="Filter pull requests"
            >
              <FunnelIcon className="size-icon-sm" />
              {activeFilterCount(filters) > 0 && (
                <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-brand text-[10px] text-white">
                  {activeFilterCount(filters)}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void pullRequestsQuery.refetch()}
              disabled={pullRequestsQuery.isFetching}
              className="flex size-9 items-center justify-center rounded border border-border bg-secondary text-normal hover:text-high disabled:opacity-50"
              aria-label="Refresh pull requests"
              title="Refresh pull requests"
            >
              <ArrowClockwiseIcon
                className={cn(
                  'size-icon-sm',
                  pullRequestsQuery.isFetching && 'animate-spin'
                )}
              />
            </button>
          </div>
        </div>

        <div className="relative mt-base">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-base top-1/2 size-icon-sm -translate-y-1/2 text-low" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, repository, author, label…"
            className="h-9 w-full rounded border border-border bg-secondary pl-10 pr-base text-sm text-normal placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
          />
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
            {filteredPullRequests.map((pr, index) => (
              <button
                type="button"
                key={pr.url}
                ref={(element) => {
                  if (element) rowRefs.current.set(pr.url, element);
                  else rowRefs.current.delete(pr.url);
                }}
                onFocus={() => setSelectedIndex(index)}
                onClick={() => setSelectedPullRequest(pr)}
                className={cn(
                  'flex w-full items-start gap-base px-double py-base text-left outline-none hover:bg-secondary/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand',
                  index === selectedIndex && 'bg-secondary/40'
                )}
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

  return (
    <>
      <Group
        orientation="horizontal"
        className="h-full min-w-0 flex-1"
        defaultLayout={{ 'pull-requests-list': 65, 'pull-request-detail': 35 }}
      >
        <Panel
          id="pull-requests-list"
          minSize="20%"
          className="h-full min-w-0 overflow-hidden bg-primary"
        >
          {listContent}
        </Panel>
        {selectedPullRequest && (
          <Separator
            id="pull-requests-separator"
            className="w-1 cursor-col-resize bg-panel outline-none transition-colors hover:bg-brand/50"
          />
        )}
        {selectedPullRequest && (
          <Panel
            id="pull-request-detail"
            minSize="400px"
            maxSize="800px"
            className="h-full min-w-0 overflow-hidden bg-secondary"
          >
            <PullRequestDetailsPanel
              prUrl={selectedPullRequest.url}
              prNumber={Number(selectedPullRequest.number)}
              onClose={closeDetails}
            />
          </Panel>
        )}
      </Group>

      <PullRequestFiltersDialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        filters={filters}
        repositories={repositories}
        authors={authors}
        onChange={setFilters}
        onReset={() => setFilters({ ...defaultFilters })}
      />
    </>
  );
}
