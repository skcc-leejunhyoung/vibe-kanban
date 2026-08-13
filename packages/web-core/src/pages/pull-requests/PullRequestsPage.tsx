import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  FunnelIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  SpinnerGapIcon,
  StackIcon,
} from '@phosphor-icons/react';
import { issuePrsApi, repoApi } from '@/shared/lib/api';
import {
  getRemoteIssue,
  listPullRequestIssueMappings,
} from '@/shared/lib/remoteApi';
import { cn } from '@/shared/lib/utils';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { usePaneNarrowerThan } from '@/shared/components/workspace-panes/PaneWidthContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useUserContext } from '@/shared/hooks/useUserContext';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import {
  PERSIST_KEYS,
  usePaneSize,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';
import { SelectionDialog } from '@/shared/dialogs/command-bar/SelectionDialog';
import { selectLinkedWorkspace } from '@/shared/dialogs/command-bar/selectLinkedWorkspace';
import { ErrorDialog } from '@vibe/ui/components/ErrorDialog';
import { isModalKeyboardActive } from '@vibe/ui/lib/modal-keyboard';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { ActionTargetType } from '@/shared/types/actions';
import { PullRequestDetailsPanel } from './PullRequestDetailsPanel';
import { PullRequestFiltersDialog } from './PullRequestFiltersDialog';
import {
  getPullRequestNumberFromUrl,
  getRepositoryNameFromPrUrl,
} from './pullRequestUrl';
import { handlePullRequestDetailsEscape } from './pullRequestDetailsEscape';
import {
  PULL_REQUESTS_FOCUS_SEARCH_EVENT,
  PULL_REQUESTS_GOTO_MAPPED_ISSUE_EVENT,
  PULL_REQUESTS_OPEN_FILTERS_EVENT,
  PULL_REQUESTS_SELECT_REPOSITORY_EVENT,
  PULL_REQUESTS_VIEW_MAPPED_WORKSPACES_EVENT,
  PULL_REQUESTS_OPEN_IN_WEB_EVENT,
  resolvePullRequestFiltersAfterDefaultsChange,
  type PullRequestFilterState,
  type PullRequestUpdatedFilter,
} from './pullRequestFilters';
import {
  pullRequestSummariesQueryOptions,
  PR_QUERY_STALE_TIME_MS,
  PR_WARMING_POLL_MS,
} from './pullRequestSummariesQuery';
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

function statusIcon(status: MergeStatus, isDraft: boolean) {
  if (status === 'merged') {
    return <GitMergeIcon className="size-icon-base text-brand" weight="bold" />;
  }
  // Draft PRs are still "open" but rendered in a muted gray so they are
  // clearly distinguishable from ready-for-review (green) pull requests.
  return (
    <GitPullRequestIcon
      className={cn(
        'size-icon-base',
        status === 'open' ? (isDraft ? 'text-low' : 'text-success') : 'text-low'
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

interface PullRequestsPageProps {
  initialPrUrl?: string;
}

type PullRequestTarget = {
  url: string;
  number: number;
};

function getPullRequestTargetFromUrl(
  prUrl: string | undefined
): PullRequestTarget | null {
  if (!prUrl) return null;
  const number = getPullRequestNumberFromUrl(prUrl);
  return number === null ? null : { url: prUrl, number };
}

export function PullRequestsPage({ initialPrUrl }: PullRequestsPageProps) {
  const isMobile = useIsMobile();
  const isNarrow = usePaneNarrowerThan(768);
  const router = useRouter();
  const appNavigation = useAppNavigation();
  const queryClient = useQueryClient();
  const { workspaces } = useUserContext();
  const { activeWorkspaces, archivedWorkspaces } = useWorkspaceContext();
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
    useState<PullRequestTarget | null>(() =>
      getPullRequestTargetFromUrl(initialPrUrl)
    );
  const [detailPanelSize, setDetailPanelSize] = usePaneSize(
    PERSIST_KEYS.pullRequestsDetailPanel,
    35
  );
  const previousDefaultFiltersRef = useRef(defaultFilters);
  const handledInitialPrUrlRef = useRef<string | undefined>(
    selectedPullRequest ? initialPrUrl : undefined
  );
  const resolvedInitialRepositoryRef = useRef<string | undefined>(undefined);
  const repositoriesKey = filters.repositories.join(',');
  const previousRepositoriesKeyRef = useRef(repositoriesKey);
  const skipNextRepositoryResetRef = useRef(false);
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const reposQuery = useQuery({
    queryKey: ['repos'],
    queryFn: () => repoApi.list(),
    staleTime: 5 * 60_000,
    gcTime: 60 * 60_000,
  });
  const repositories = useMemo(
    () =>
      (reposQuery.data ?? []).map((repo) => ({
        value: repo.id,
        label: repo.display_name,
        name: repo.name,
        path: repo.path,
      })),
    [reposQuery.data]
  );

  useEffect(() => {
    if (!reposQuery.isSuccess) return;
    const valid = new Set(repositories.map((repository) => repository.value));
    if (filters.repositories.every((id) => valid.has(id))) return;
    setFilters((current) => ({
      ...current,
      repositories: current.repositories.filter((id) => valid.has(id)),
    }));
  }, [repositoriesKey, reposQuery.isSuccess, repositories]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // One query per selected repository; the lists are merged below. Each query
  // keeps its own cache entry (and warming poll) so a shared repo stays warm
  // across single- and multi-select views.
  const pullRequestQueries = useQueries({
    queries: filters.repositories.map((repository) => ({
      ...pullRequestSummariesQueryOptions(repository, filters.involvesMe),
      staleTime: PR_QUERY_STALE_TIME_MS,
      gcTime: 60 * 60_000,
      // Cold/stale opens return an empty list immediately while the backend
      // refreshes `gh`; poll until the warmed list arrives, then stop.
      refetchInterval: (query: { state: { data?: { warming?: boolean } } }) =>
        query.state.data?.warming ? PR_WARMING_POLL_MS : false,
      refetchIntervalInBackground: false,
    })),
  });
  const hasRepositories = filters.repositories.length > 0;
  const prsLoading =
    hasRepositories && pullRequestQueries.every((query) => query.isLoading);
  const prsError =
    hasRepositories && pullRequestQueries.every((query) => query.isError);
  const prsErrorMessage = pullRequestQueries.find((query) => query.isError)
    ?.error?.message;
  const prsFetching = pullRequestQueries.some((query) => query.isFetching);

  const refreshPullRequests = useMutation({
    mutationFn: async ({
      repositories,
      involvesMe,
    }: {
      repositories: string[];
      involvesMe: boolean;
    }) => {
      const results = await Promise.all(
        repositories.map(async (repository) => ({
          repository,
          result: await repoApi.listPullRequestSummaries(
            repository,
            involvesMe,
            true
          ),
        }))
      );
      const failed = results.find(({ result }) => !result.success);
      if (failed && !failed.result.success) {
        throw new Error(
          failed.result.message || 'Failed to refresh pull requests'
        );
      }
      return results;
    },
    onSuccess: (results, variables) => {
      for (const { repository, result } of results) {
        if (!result.success) continue;
        queryClient.setQueryData(
          pullRequestSummariesQueryOptions(repository, variables.involvesMe)
            .queryKey,
          result.data
        );
      }
    },
    onError: (error) =>
      ErrorDialog.show({
        title: 'Could not refresh pull requests',
        message:
          error instanceof Error ? error.message : 'An unknown error occurred.',
        buttonText: 'OK',
      }),
  });

  const pullRequests = useMemo(
    () =>
      pullRequestQueries
        .flatMap((query) => query.data?.summaries ?? [])
        .sort((a, b) => {
          const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
          const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
          return tb - ta;
        }),
    [pullRequestQueries]
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

  const workspaceSummaries = useMemo(
    () => [...activeWorkspaces, ...archivedWorkspaces],
    [activeWorkspaces, archivedWorkspaces]
  );

  const prefetchPullRequest = useCallback(
    (pullRequest: PullRequestSummary) =>
      queryClient.prefetchQuery({
        queryKey: ['pr-detail', pullRequest.url],
        queryFn: async () => {
          const result = await issuePrsApi.getPrInfo(pullRequest.url);
          if (!result.success) {
            throw new Error(result.message || 'Failed to load pull request');
          }
          return result.data;
        },
        staleTime: PR_QUERY_STALE_TIME_MS,
        gcTime: 30 * 60_000,
      }),
    [queryClient]
  );

  const cancelScheduledPrefetch = useCallback(() => {
    if (prefetchTimerRef.current) {
      clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  }, []);

  const schedulePullRequestPrefetch = useCallback(
    (pullRequest: PullRequestSummary) => {
      cancelScheduledPrefetch();
      prefetchTimerRef.current = setTimeout(() => {
        prefetchTimerRef.current = null;
        void prefetchPullRequest(pullRequest);
      }, 150);
    },
    [cancelScheduledPrefetch, prefetchPullRequest]
  );

  useEffect(
    () => () => {
      cancelScheduledPrefetch();
    },
    [cancelScheduledPrefetch]
  );

  const goToMappedIssue = useCallback(
    async (pullRequest: Pick<PullRequestTarget, 'url'>) => {
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
    async (pullRequest: Pick<PullRequestTarget, 'url'>) => {
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
        const selected = await selectLinkedWorkspace({
          title: 'Mapped workspaces',
          workspaces: mappedWorkspaces,
          workspaceSummaries,
          getDescriptionPrefix: (workspace) =>
            mappedIssues.find(
              ({ link }) => link.issue_id === workspace.issue_id
            )?.issue.simple_id,
        });
        if (selected) {
          appNavigation.goToWorkspace(selected.local_workspace_id, {
            hostId: selected.host_id,
          });
        }
      } catch (error) {
        await ErrorDialog.show({
          title: 'Could not load mapped workspaces',
          message: error instanceof Error ? error.message : 'Please try again.',
          buttonText: 'OK',
        });
      }
    },
    [appNavigation, loadMappedIssues, workspaces, workspaceSummaries]
  );

  useEffect(() => {
    if (!initialPrUrl || handledInitialPrUrlRef.current === initialPrUrl) {
      return;
    }
    const prNumber = getPullRequestNumberFromUrl(initialPrUrl);
    if (prNumber === null) return;
    handledInitialPrUrlRef.current = initialPrUrl;
    setSelectedPullRequest({ url: initialPrUrl, number: prNumber });
  }, [initialPrUrl]);

  useEffect(() => {
    if (
      !initialPrUrl ||
      resolvedInitialRepositoryRef.current === initialPrUrl ||
      repositories.length === 0
    ) {
      return;
    }
    resolvedInitialRepositoryRef.current = initialPrUrl;
    const repositoryName = getRepositoryNameFromPrUrl(initialPrUrl);
    if (!repositoryName) return;
    const repository = repositories.find(
      (candidate) =>
        candidate.name === repositoryName ||
        candidate.label === repositoryName ||
        candidate.path.split('/').pop() === repositoryName
    );
    if (repository && !filters.repositories.includes(repository.value)) {
      skipNextRepositoryResetRef.current = true;
      setFilters((current) => ({
        ...current,
        repositories: [...current.repositories, repository.value],
      }));
    }
  }, [repositoriesKey, initialPrUrl, repositories]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!initialPrUrl) return;
    const index = filteredPullRequests.findIndex(
      (candidate) => candidate.url === initialPrUrl
    );
    if (index >= 0) setSelectedIndex(index);
  }, [filteredPullRequests, initialPrUrl]);

  useEffect(() => {
    setSelectedIndex((current) =>
      Math.min(current, Math.max(0, filteredPullRequests.length - 1))
    );
  }, [filteredPullRequests.length]);

  useEffect(() => {
    if (previousRepositoriesKeyRef.current === repositoriesKey) return;
    previousRepositoriesKeyRef.current = repositoriesKey;
    if (skipNextRepositoryResetRef.current) {
      skipNextRepositoryResetRef.current = false;
      setSelectedIndex(0);
      return;
    }
    setSelectedPullRequest(null);
    setSelectedIndex(0);
  }, [repositoriesKey]);

  useEffect(() => {
    const openFilters = () => setFiltersOpen(true);
    const focusSearch = () => searchInputRef.current?.focus();
    const selectRepository = (event: Event) => {
      const repoId = (event as CustomEvent<{ repoId?: string }>).detail?.repoId;
      if (!repoId) return;
      setFilters((current) =>
        current.repositories.includes(repoId)
          ? current
          : { ...current, repositories: [...current.repositories, repoId] }
      );
    };
    const getSelectedPullRequest = () =>
      selectedPullRequest ?? filteredPullRequests[selectedIndex] ?? null;
    const gotoMappedIssue = () => {
      const pullRequest = getSelectedPullRequest();
      if (pullRequest) void goToMappedIssue(pullRequest);
    };
    const showMappedWorkspaces = () => {
      const pullRequest = getSelectedPullRequest();
      if (pullRequest) void viewMappedWorkspaces(pullRequest);
    };
    const openInWeb = () => {
      const pullRequest = getSelectedPullRequest();
      if (pullRequest) openExternalUrl(pullRequest.url);
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
    window.addEventListener(PULL_REQUESTS_OPEN_IN_WEB_EVENT, openInWeb);
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
      window.removeEventListener(PULL_REQUESTS_OPEN_IN_WEB_EVENT, openInWeb);
    };
  }, [
    filteredPullRequests,
    goToMappedIssue,
    selectedIndex,
    selectedPullRequest,
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

  const openDetails = useCallback(
    (pullRequest: Pick<PullRequestSummary, 'url' | 'number'>) => {
      setSelectedPullRequest({
        url: pullRequest.url,
        number: Number(pullRequest.number),
      });
      appNavigation.goToPullRequests(pullRequest.url, { replace: true });
    },
    [appNavigation]
  );

  const closeDetails = useCallback(() => {
    setSelectedPullRequest(null);
    appNavigation.goToPullRequests(undefined, { replace: true });
    window.requestAnimationFrame(() => focusRow(selectedIndex));
  }, [appNavigation, focusRow, selectedIndex]);

  useEffect(() => {
    if (!selectedPullRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (isModalKeyboardActive()) return;
      handlePullRequestDetailsEscape(
        event,
        document.activeElement as HTMLElement | null,
        closeDetails
      );
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [closeDetails, selectedPullRequest]);

  useEffect(() => {
    if (!selectedPullRequest || filteredPullRequests.length === 0) return;
    const handleDetailNavigation = (event: KeyboardEvent) => {
      if (isModalKeyboardActive()) return;
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
        shouldIgnoreListKeyboardNavigation(event.target)
      ) {
        return;
      }
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const currentIndex = filteredPullRequests.findIndex(
        (candidate) => candidate.url === selectedPullRequest.url
      );
      if (currentIndex < 0) return;
      const nextIndex = Math.min(
        filteredPullRequests.length - 1,
        Math.max(0, currentIndex + direction)
      );
      const nextPullRequest = filteredPullRequests[nextIndex];
      if (!nextPullRequest || nextIndex === currentIndex) return;
      setSelectedIndex(nextIndex);
      openDetails(nextPullRequest);
      void prefetchPullRequest(nextPullRequest);
    };
    window.addEventListener('keydown', handleDetailNavigation);
    return () => window.removeEventListener('keydown', handleDetailNavigation);
  }, [
    filteredPullRequests,
    openDetails,
    prefetchPullRequest,
    selectedPullRequest,
  ]);

  useEffect(() => {
    if (selectedPullRequest || filteredPullRequests.length === 0) return;

    const handleListKeyDown = (event: KeyboardEvent) => {
      if (isModalKeyboardActive()) return;
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
        // First press with focus outside the list anchors on the currently
        // highlighted row instead of advancing past it — otherwise the focus
        // border appears one row below where the selection highlight sits.
        const active = document.activeElement;
        const focusInList =
          active instanceof HTMLElement &&
          active.hasAttribute('data-pull-request-primary');
        const delta = !focusInList ? 0 : event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = Math.min(
          filteredPullRequests.length - 1,
          Math.max(0, selectedIndex + delta)
        );
        setSelectedIndex(nextIndex);
        focusRow(nextIndex);
      } else if (event.key === 'Enter') {
        const pullRequest = filteredPullRequests[selectedIndex];
        if (pullRequest) {
          event.preventDefault();
          openDetails(pullRequest);
        }
      }
    };

    window.addEventListener('keydown', handleListKeyDown);
    return () => window.removeEventListener('keydown', handleListKeyDown);
  }, [
    filteredPullRequests,
    focusRow,
    openDetails,
    selectedIndex,
    selectedPullRequest,
  ]);

  const listContent = (
    <main className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border px-double py-base">
        <div className="flex min-w-0 items-center gap-half">
          <button
            type="button"
            onClick={() => router.history.back()}
            className={cn(
              'flex items-center justify-center rounded-sm p-half text-low transition-colors',
              !(isMobile || isNarrow) && 'sm:hidden',
              'hover:bg-secondary hover:text-normal',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand'
            )}
            aria-label="Go back"
            title="Back"
          >
            <ArrowLeftIcon size={18} />
          </button>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-high">Pull Requests</h1>
            <p className="mt-half text-sm text-low">
              {filters.involvesMe
                ? 'Pull requests involving you in the selected repositories'
                : 'Recently updated pull requests in the selected repositories'}
            </p>
          </div>
        </div>

        <div className="mt-base flex items-center gap-half">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-base top-1/2 size-icon-sm -translate-y-1/2 text-low" />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, repository, author, label…"
              className="h-9 w-full rounded border border-border bg-secondary pl-10 pr-base text-sm text-normal placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className="relative flex size-9 shrink-0 items-center justify-center rounded border border-border bg-secondary text-normal hover:text-high"
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
            onClick={() =>
              refreshPullRequests.mutate({
                repositories: filters.repositories,
                involvesMe: filters.involvesMe,
              })
            }
            disabled={
              !hasRepositories || prsFetching || refreshPullRequests.isPending
            }
            className="flex size-9 shrink-0 items-center justify-center rounded border border-border bg-secondary text-normal hover:text-high disabled:opacity-50"
            aria-label="Refresh pull requests"
            title="Refresh pull requests"
          >
            <ArrowClockwiseIcon
              className={cn(
                'size-icon-sm',
                (prsFetching || refreshPullRequests.isPending) && 'animate-spin'
              )}
            />
          </button>
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
        ) : !hasRepositories ? (
          <div className="flex flex-1 items-center justify-center px-double text-center text-sm text-low">
            Open the filters to choose repositories and view their pull
            requests.
          </div>
        ) : prsLoading ? (
          <div className="flex h-full items-center justify-center gap-half text-low">
            <SpinnerGapIcon className="size-icon-base animate-spin" />
            Loading pull requests…
          </div>
        ) : prsError ? (
          <div className="flex h-full flex-col items-center justify-center px-double text-center">
            <GitPullRequestIcon className="size-8 text-low" />
            <p className="mt-base text-base font-medium text-high">
              Could not load pull requests
            </p>
            <p className="mt-half max-w-lg text-sm text-low">
              {prsErrorMessage}
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
                  onMouseEnter={() => schedulePullRequestPrefetch(pr)}
                  onMouseLeave={cancelScheduledPrefetch}
                  onFocusCapture={() => {
                    cancelScheduledPrefetch();
                    void prefetchPullRequest(pr);
                  }}
                  onClick={() => openDetails(pr)}
                  className="flex min-w-0 flex-1 items-start gap-base px-double py-base text-left"
                >
                  <span className="mt-half">
                    {statusIcon(pr.status, pr.is_draft)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-half">
                      <span className="truncate text-base font-medium text-high">
                        {pr.title}
                      </span>
                      {pr.is_draft && (
                        <span className="inline-flex items-center gap-1 rounded bg-tertiary px-half py-0.5 text-xs text-low">
                          <GitPullRequestIcon
                            className="size-icon-xs"
                            weight="bold"
                          />
                          Draft
                        </span>
                      )}
                      {pr.review_decision === 'APPROVED' && (
                        <span className="inline-flex items-center gap-1 rounded bg-success/10 px-half py-0.5 text-xs text-success">
                          <CheckCircleIcon
                            className="size-icon-xs"
                            weight="fill"
                          />
                          Approved
                        </span>
                      )}
                      {pr.is_review_requested && (
                        <span className="rounded bg-brand/10 px-half py-0.5 text-xs text-brand">
                          Review requested
                        </span>
                      )}
                      {/* A pending review request supersedes a stale
                          CHANGES_REQUESTED, matching the details panel. */}
                      {pr.review_decision === 'CHANGES_REQUESTED' &&
                        !pr.is_review_requested && (
                          <span className="rounded bg-error/10 px-half py-0.5 text-xs text-error">
                            Changes requested
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
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openExternalUrl(pr.url);
                    }}
                    className="flex size-8 items-center justify-center rounded text-low hover:bg-secondary hover:text-high"
                    aria-label={`Open pull request #${String(pr.number)} in web`}
                    title="Open in web"
                  >
                    <GlobeIcon className="size-icon-sm" />
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
      prNumber={selectedPullRequest.number}
      onClose={closeDetails}
    />
  ) : null;

  const pullRequestsDefaultLayout: Layout =
    typeof detailPanelSize === 'number'
      ? {
          'pull-requests-list': 100 - detailPanelSize,
          'pull-request-detail': detailPanelSize,
        }
      : {
          'pull-requests-list': 65,
          'pull-request-detail': 35,
        };

  const onPullRequestsLayoutChange = useCallback(
    (layout: Layout) => {
      if (selectedPullRequest) {
        setDetailPanelSize(layout['pull-request-detail']);
      }
    },
    [selectedPullRequest, setDetailPanelSize]
  );

  return (
    <>
      {isMobile || isNarrow ? (
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
          defaultLayout={pullRequestsDefaultLayout}
          onLayoutChange={onPullRequestsLayoutChange}
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
        onReset={() => setFilters({ ...defaultFilters })}
      />
    </>
  );
}
