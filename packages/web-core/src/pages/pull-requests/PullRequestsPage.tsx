import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  ChatCircleIcon,
  FunnelIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  MagnifyingGlassIcon,
  SpinnerGapIcon,
  StackIcon,
} from '@phosphor-icons/react';
import { repoApi } from '@/shared/lib/api';
import {
  getRemoteIssue,
  listPullRequestIssueMappings,
} from '@/shared/lib/remoteApi';
import { cn } from '@/shared/lib/utils';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useUserContext } from '@/shared/hooks/useUserContext';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { SelectionDialog } from '@/shared/dialogs/command-bar/SelectionDialog';
import { ErrorDialog } from '@vibe/ui/components/ErrorDialog';
import { ActionTargetType } from '@/shared/types/actions';
import { PullRequestDetailsPanel } from './PullRequestDetailsPanel';
import { PullRequestFiltersDialog } from './PullRequestFiltersDialog';
import {
  PULL_REQUESTS_FOCUS_SEARCH_EVENT,
  PULL_REQUESTS_GOTO_MAPPED_ISSUE_EVENT,
  PULL_REQUESTS_OPEN_FILTERS_EVENT,
  PULL_REQUESTS_SELECT_REPOSITORY_EVENT,
  PULL_REQUESTS_VIEW_MAPPED_WORKSPACES_EVENT,
  resolvePullRequestFiltersAfterDefaultsChange,
  type PullRequestFilterState,
  type PullRequestUpdatedFilter,
} from './pullRequestFilters';
import type { MergeStatus, PullRequestSummary } from 'shared/types';
import type { Issue, PullRequestIssue, Workspace } from 'shared/remote-types';

type MappedIssue = {
  link: PullRequestIssue;
  issue: Issue;
};

async function showEmptyMapping(message: string) {
  await ErrorDialog.show({
    title: 'No mapping found',
    message,
    buttonText: 'OK',
  });
}

async function selectMappedIssue(
  mappedIssues: MappedIssue[]
): Promise<MappedIssue | undefined> {
  if (mappedIssues.length === 1) return mappedIssues[0];
  const selectedIssueId = (await SelectionDialog.show({
    initialPageId: 'mappedIssues',
    pages: {
      mappedIssues: {
        id: 'mappedIssues',
        title: 'Mapped issues',
        buildGroups: () => [
          {
            label: 'Issues',
            items: mappedIssues.map(({ issue }) => ({
              type: 'action' as const,
              action: {
                id: issue.id,
                label: issue.title,
                description: issue.simple_id,
                icon: ArrowSquareOutIcon,
                requiresTarget: ActionTargetType.NONE,
                execute: () => {},
              },
            })),
          },
        ],
        onSelect: (item) => ({
          type: 'complete' as const,
          data: item.type === 'action' ? item.action.id : undefined,
        }),
      },
    },
  })) as string | undefined;
  return mappedIssues.find(({ issue }) => issue.id === selectedIssueId);
}

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

function shouldIgnoreListKeyboardNavigation(
  target: EventTarget | null
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[data-pull-request-primary]')) return false;

  return Boolean(
    target.isContentEditable ||
      target.closest(
        'input, textarea, select, button, a, [role="button"], [role="dialog"]'
      )
  );
}

function activeFilterCount(filters: PullRequestFilterState): number {
  return [
    filters.status !== 'all',
    filters.author !== 'all',
    filters.draft !== 'all',
    filters.updated !== 'all',
    filters.involvesMe,
  ].filter(Boolean).length;
}

export function PullRequestsPage() {
  const isMobile = useIsMobile();
  const appNavigation = useAppNavigation();
  const { workspaces } = useUserContext();
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
  const previousDefaultFiltersRef = useRef(defaultFilters);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const reposQuery = useQuery({
    queryKey: ['repos'],
    queryFn: () => repoApi.list(),
    staleTime: 5 * 60_000,
  });
  const repositories = useMemo(
    () =>
      (reposQuery.data ?? []).map((repo) => ({
        value: repo.id,
        label: repo.display_name,
      })),
    [reposQuery.data]
  );

  useEffect(() => {
    if (
      !reposQuery.isSuccess ||
      filters.repository === 'all' ||
      repositories.some((repository) => repository.value === filters.repository)
    ) {
      return;
    }
    setFilters((current) => ({ ...current, repository: 'all' }));
  }, [filters.repository, reposQuery.isSuccess, repositories]);

  useEffect(() => {
    setFilters((current) =>
      resolvePullRequestFiltersAfterDefaultsChange(
        current,
        previousDefaultFiltersRef.current,
        defaultFilters
      )
    );
    previousDefaultFiltersRef.current = defaultFilters;
  }, [defaultFilters]);

  const pullRequestsQuery = useQuery({
    queryKey: [
      'pull-request-summaries',
      filters.repository,
      filters.involvesMe,
    ],
    queryFn: async () => {
      const result = await repoApi.listPullRequestSummaries(
        filters.repository,
        filters.involvesMe
      );
      if (!result.success) {
        throw new Error(result.message || 'Failed to load pull requests');
      }
      return result.data;
    },
    enabled: filters.repository !== 'all',
    staleTime: 5 * 60_000,
  });

  const pullRequests = useMemo(
    () => pullRequestsQuery.data ?? [],
    [pullRequestsQuery.data]
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

  const loadMappedIssues = useCallback(async (prUrl: string) => {
    const links = await listPullRequestIssueMappings(prUrl);
    return Promise.all(
      links.map(async (link) => ({
        link,
        issue: await getRemoteIssue(link.issue_id),
      }))
    );
  }, []);

  const goToMappedIssue = useCallback(
    async (pullRequest: PullRequestSummary) => {
      try {
        const mappedIssues = await loadMappedIssues(pullRequest.url);
        if (mappedIssues.length === 0) {
          await showEmptyMapping(
            'This pull request is not mapped to an issue.'
          );
          return;
        }
        const selected = await selectMappedIssue(mappedIssues);
        if (selected) {
          appNavigation.goToProjectIssue(
            selected.link.project_id,
            selected.link.issue_id
          );
        }
      } catch (error) {
        await ErrorDialog.show({
          title: 'Could not load mapped issue',
          message: error instanceof Error ? error.message : 'Please try again.',
          buttonText: 'OK',
        });
      }
    },
    [appNavigation, loadMappedIssues]
  );

  const viewMappedWorkspaces = useCallback(
    async (pullRequest: PullRequestSummary) => {
      try {
        const mappedIssues = await loadMappedIssues(pullRequest.url);
        const issueIds = new Set(mappedIssues.map(({ link }) => link.issue_id));
        const mappedWorkspaces = workspaces.filter(
          (
            workspace
          ): workspace is Workspace & {
            issue_id: string;
            local_workspace_id: string;
          } =>
            workspace.issue_id !== null &&
            workspace.local_workspace_id !== null &&
            issueIds.has(workspace.issue_id)
        );
        if (mappedWorkspaces.length === 0) {
          await showEmptyMapping('This pull request has no mapped workspaces.');
          return;
        }
        const selectedWorkspaceId = (await SelectionDialog.show({
          initialPageId: 'mappedWorkspaces',
          pages: {
            mappedWorkspaces: {
              id: 'mappedWorkspaces',
              title: 'Mapped workspaces',
              buildGroups: () => [
                {
                  label: 'Workspaces',
                  items: mappedWorkspaces.map((workspace) => {
                    const mappedIssue = mappedIssues.find(
                      ({ link }) => link.issue_id === workspace.issue_id
                    );
                    return {
                      type: 'action' as const,
                      action: {
                        id: workspace.id,
                        label: workspace.name || 'Untitled workspace',
                        description: mappedIssue?.issue.simple_id,
                        icon: StackIcon,
                        requiresTarget: ActionTargetType.NONE,
                        execute: () => {},
                      },
                    };
                  }),
                },
              ],
              onSelect: (item) => ({
                type: 'complete' as const,
                data: item.type === 'action' ? item.action.id : undefined,
              }),
            },
          },
        })) as string | undefined;
        const selected = mappedWorkspaces.find(
          (workspace) => workspace.id === selectedWorkspaceId
        );
        if (selected) {
          appNavigation.goToProjectIssueWorkspace(
            selected.project_id,
            selected.issue_id,
            selected.local_workspace_id,
            { hostId: selected.host_id }
          );
        }
      } catch (error) {
        await ErrorDialog.show({
          title: 'Could not load mapped workspaces',
          message: error instanceof Error ? error.message : 'Please try again.',
          buttonText: 'OK',
        });
      }
    },
    [appNavigation, loadMappedIssues, workspaces]
  );

  useEffect(() => {
    setSelectedIndex((current) =>
      Math.min(current, Math.max(0, filteredPullRequests.length - 1))
    );
  }, [filteredPullRequests.length]);

  useEffect(() => {
    setSelectedPullRequest(null);
    setSelectedIndex(0);
  }, [filters.repository]);

  useEffect(() => {
    const openFilters = () => setFiltersOpen(true);
    const focusSearch = () => searchInputRef.current?.focus();
    const selectRepository = (event: Event) => {
      const repoId = (event as CustomEvent<{ repoId?: string }>).detail?.repoId;
      if (!repoId) return;
      setFilters((current) => ({ ...current, repository: repoId }));
    };
    const getSelectedPullRequest = () =>
      filteredPullRequests[selectedIndex] ?? null;
    const gotoMappedIssue = () => {
      const pullRequest = getSelectedPullRequest();
      if (pullRequest) void goToMappedIssue(pullRequest);
    };
    const showMappedWorkspaces = () => {
      const pullRequest = getSelectedPullRequest();
      if (pullRequest) void viewMappedWorkspaces(pullRequest);
    };
    window.addEventListener(PULL_REQUESTS_OPEN_FILTERS_EVENT, openFilters);
    window.addEventListener(PULL_REQUESTS_FOCUS_SEARCH_EVENT, focusSearch);
    window.addEventListener(
      PULL_REQUESTS_SELECT_REPOSITORY_EVENT,
      selectRepository
    );
    window.addEventListener(
      PULL_REQUESTS_GOTO_MAPPED_ISSUE_EVENT,
      gotoMappedIssue
    );
    window.addEventListener(
      PULL_REQUESTS_VIEW_MAPPED_WORKSPACES_EVENT,
      showMappedWorkspaces
    );
    return () => {
      window.removeEventListener(PULL_REQUESTS_OPEN_FILTERS_EVENT, openFilters);
      window.removeEventListener(PULL_REQUESTS_FOCUS_SEARCH_EVENT, focusSearch);
      window.removeEventListener(
        PULL_REQUESTS_SELECT_REPOSITORY_EVENT,
        selectRepository
      );
      window.removeEventListener(
        PULL_REQUESTS_GOTO_MAPPED_ISSUE_EVENT,
        gotoMappedIssue
      );
      window.removeEventListener(
        PULL_REQUESTS_VIEW_MAPPED_WORKSPACES_EVENT,
        showMappedWorkspaces
      );
    };
  }, [
    filteredPullRequests,
    goToMappedIssue,
    selectedIndex,
    viewMappedWorkspaces,
  ]);

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

  useEffect(() => {
    if (selectedPullRequest || filteredPullRequests.length === 0) return;

    const handleListKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        shouldIgnoreListKeyboardNavigation(event.target)
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

    window.addEventListener('keydown', handleListKeyDown);
    return () => window.removeEventListener('keydown', handleListKeyDown);
  }, [filteredPullRequests, focusRow, selectedIndex, selectedPullRequest]);

  const listContent = (
    <main className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border px-double py-base">
        <div className="flex items-center justify-between gap-base">
          <div>
            <h1 className="text-xl font-semibold text-high">Pull Requests</h1>
            <p className="mt-half text-sm text-low">
              {filters.involvesMe
                ? 'Pull requests involving you in the selected repository'
                : 'Recently updated pull requests in the selected repository'}
            </p>
          </div>
          <div className="flex items-center gap-half">
            <select
              value={filters.repository}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  repository: event.target.value,
                }))
              }
              className="h-9 max-w-64 rounded border border-border bg-secondary px-base text-sm text-normal focus:outline-none focus:ring-1 focus:ring-brand"
              aria-label="Repository"
            >
              <option value="all">Select repository</option>
              {repositories.map((repository) => (
                <option key={repository.value} value={repository.value}>
                  {repository.label}
                </option>
              ))}
            </select>
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
        {reposQuery.isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <SpinnerGapIcon className="size-icon-lg animate-spin text-low" />
          </div>
        ) : repositories.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-double text-center text-sm text-low">
            Register a repository before viewing pull requests.
          </div>
        ) : filters.repository === 'all' ? (
          <div className="flex flex-1 items-center justify-center px-double text-center text-sm text-low">
            Select a repository to view its pull requests.
          </div>
        ) : pullRequestsQuery.isLoading ? (
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
              <div
                data-pull-request-row
                key={pr.url}
                className={cn(
                  'flex w-full items-start pr-base hover:bg-secondary/60',
                  index === selectedIndex && 'bg-secondary/40'
                )}
              >
                <button
                  type="button"
                  data-pull-request-primary
                  ref={(element) => {
                    if (element) rowRefs.current.set(pr.url, element);
                    else rowRefs.current.delete(pr.url);
                  }}
                  onFocus={() => setSelectedIndex(index)}
                  onClick={() => setSelectedPullRequest(pr)}
                  className="flex min-w-0 flex-1 items-start gap-base px-double py-base text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand"
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
                <span className="flex shrink-0 items-center gap-half py-base">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void goToMappedIssue(pr);
                    }}
                    className="flex size-8 items-center justify-center rounded text-low hover:bg-secondary hover:text-high"
                    aria-label={`Go to issue mapped to pull request #${String(pr.number)}`}
                    title="Go to mapped issue"
                  >
                    <ArrowSquareOutIcon className="size-icon-sm" />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void viewMappedWorkspaces(pr);
                    }}
                    className="flex size-8 items-center justify-center rounded text-low hover:bg-secondary hover:text-high"
                    aria-label={`View workspaces mapped to pull request #${String(pr.number)}`}
                    title="View mapped workspaces"
                  >
                    <StackIcon className="size-icon-sm" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );

  const detailsContent = selectedPullRequest ? (
    <PullRequestDetailsPanel
      prUrl={selectedPullRequest.url}
      prNumber={Number(selectedPullRequest.number)}
      onClose={closeDetails}
    />
  ) : null;

  return (
    <>
      {isMobile ? (
        <div
          className={cn(
            'h-full min-h-0 w-full overflow-hidden',
            selectedPullRequest ? 'bg-secondary' : 'bg-primary'
          )}
        >
          {detailsContent ?? listContent}
        </div>
      ) : (
        <Group
          orientation="horizontal"
          className="h-full min-w-0 flex-1"
          defaultLayout={{
            'pull-requests-list': 65,
            'pull-request-detail': 35,
          }}
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
              {detailsContent}
            </Panel>
          )}
        </Group>
      )}

      <PullRequestFiltersDialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        filters={filters}
        repositories={repositories}
        authors={authors}
        onChange={setFilters}
        onReset={() =>
          setFilters({
            ...defaultFilters,
            repository: filters.repository,
          })
        }
        showRepository={false}
      />
    </>
  );
}
