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
import {
  getGitHubPullRequest,
  getRemoteIssue,
  isGitHubAuthenticationError,
  listGitHubRepositories,
  listPullRequestIssueMappings,
  listPullRequestIssueMappingsBatch,
} from '@/shared/lib/remoteApi';
import { cn } from '@/shared/lib/utils';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { usePaneNarrowerThan } from '@/shared/components/workspace-panes/PaneWidthContext';
import { useIsActivePane } from '@/shared/components/workspace-panes/PaneActiveContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useUserContext } from '@/shared/hooks/useUserContext';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useSelfCloudHostId } from '@/shared/hooks/useSelfCloudHostId';
import {
  PERSIST_KEYS,
  usePaneSize,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';
import { SelectionDialog } from '@/shared/dialogs/command-bar/SelectionDialog';
import { selectLinkedWorkspace } from '@/shared/dialogs/command-bar/selectLinkedWorkspace';
import { ErrorDialog } from '@vibe/ui/components/ErrorDialog';
import { GitHubApiErrorAlert } from '@/shared/components/GitHubApiErrorAlert';
import { LoginRequiredPrompt } from '@/shared/dialogs/shared/LoginRequiredPrompt';
import { isModalKeyboardActive } from '@vibe/ui/lib/modal-keyboard';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { ActionTargetType } from '@/shared/types/actions';
import { PullRequestDetailsPanel } from './PullRequestDetailsPanel';
import { getPullRequestTargetFromUrl } from './pullRequestDetailsState';
import { PullRequestFiltersDialog } from './PullRequestFiltersDialog';
import { getRepositoryFullNameFromPrUrl } from './pullRequestUrl';
import { handlePullRequestDetailsEscape } from './pullRequestDetailsEscape';
import {
  hasPullRequestWorkspace,
  mergeMappedPullRequestWorkspaces,
} from './localPullRequestWorkspaces';
import {
  PULL_REQUESTS_FOCUS_SEARCH_EVENT,
  PULL_REQUESTS_GOTO_MAPPED_ISSUE_EVENT,
  PULL_REQUESTS_OPEN_FILTERS_EVENT,
  PULL_REQUESTS_REFRESH_EVENT,
  PULL_REQUESTS_VIEW_MAPPED_WORKSPACES_EVENT,
  PULL_REQUESTS_OPEN_IN_WEB_EVENT,
  prunePullRequestRepositories,
  resolvePullRequestFiltersAfterDefaultsChange,
  resolvePullRequestFiltersAfterRepositoriesChange,
  type PullRequestFilterState,
  type PullRequestUpdatedFilter,
} from './pullRequestFilters';
import {
  pullRequestSummariesQueryOptions,
  PR_QUERY_STALE_TIME_MS,
  refreshPullRequestSummaries,
  storeRefreshedPullRequestSummaries,
  summarizePullRequestQueryErrors,
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

export function getPullRequestsDefaultLayout(
  detailPanelSize: number | string,
  hasDetails: boolean
): Layout {
  if (!hasDetails) return { 'pull-requests-list': 100 };
  const detailSize = typeof detailPanelSize === 'number' ? detailPanelSize : 35;
  return {
    'pull-requests-list': 100 - detailSize,
    'pull-request-detail': detailSize,
  };
}

type PullRequestTarget = {
  url: string;
  number: number;
};

export function PullRequestsPage({ initialPrUrl }: PullRequestsPageProps) {
  const selectedPullRequest = useMemo(
    () => getPullRequestTargetFromUrl(initialPrUrl),
    [initialPrUrl]
  );
  const normalizedInitialPrUrl = selectedPullRequest?.url;
  const isMobile = useIsMobile();
  const isNarrow = usePaneNarrowerThan(768);
  const isActivePane = useIsActivePane();
  const router = useRouter();
  const appNavigation = useAppNavigation();
  const queryClient = useQueryClient();
  const { isLoaded: isAuthLoaded, isSignedIn, userId } = useAuth();
  const { workspaces } = useUserContext();
  const { activeWorkspaces, archivedWorkspaces } = useWorkspaceContext();
  const { hostId: selfHostId } = useSelfCloudHostId();
  const defaultFilters = useUiPreferencesStore(
    (state) => state.pullRequestDefaultFilters
  );
  const setDefaultFilters = useUiPreferencesStore(
    (state) => state.setPullRequestDefaultFilters
  );
  const [filters, setFilters] = useState<PullRequestFilterState>(() => ({
    ...defaultFilters,
  }));
  const [query, setQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailPanelSize, setDetailPanelSize] = usePaneSize(
    PERSIST_KEYS.pullRequestsDetailPanel,
    35
  );
  const previousDefaultFiltersRef = useRef(defaultFilters);
  const resolvedInitialRepositoryRef = useRef<string | undefined>(undefined);
  const repositoriesKey = filters.repositories.join(',');
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const reposQuery = useQuery({
    queryKey: ['github-repositories'],
    queryFn: listGitHubRepositories,
    staleTime: 5 * 60_000,
    gcTime: 60 * 60_000,
    enabled: isSignedIn,
  });
  const repositories = useMemo(
    () =>
      (reposQuery.data ?? []).map((repo) => ({
        value: repo.full_name,
        label: repo.full_name,
      })),
    [reposQuery.data]
  );

  useEffect(() => {
    if (!reposQuery.isSuccess) return;
    const valid = new Set(repositories.map((repository) => repository.value));
    const prunedDefaults = prunePullRequestRepositories(defaultFilters, valid);
    if (prunedDefaults !== defaultFilters) {
      setDefaultFilters(prunedDefaults);
    }
    setFilters((current) =>
      resolvePullRequestFiltersAfterRepositoriesChange(
        current,
        prunedDefaults,
        valid
      )
    );
  }, [
    defaultFilters,
    repositoriesKey,
    reposQuery.isSuccess,
    repositories,
    setDefaultFilters,
  ]);

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
  // keeps its own cache entry across single- and multi-select views.
  const pullRequestQueries = useQueries({
    queries: isSignedIn
      ? filters.repositories.map((repository) => ({
          ...pullRequestSummariesQueryOptions(
            userId,
            repository,
            filters.involvesMe
          ),
          staleTime: PR_QUERY_STALE_TIME_MS,
          gcTime: 60 * 60_000,
        }))
      : [],
  });
  const hasRepositories = filters.repositories.length > 0;
  const prsLoading =
    hasRepositories &&
    !pullRequestQueries.some((query) => query.isSuccess) &&
    pullRequestQueries.some((query) => query.isLoading);
  const queryErrors = summarizePullRequestQueryErrors(pullRequestQueries);
  const prsError = hasRepositories && queryErrors.allFailed;
  const prsPartialError = hasRepositories && queryErrors.partiallyFailed;
  const prsErrorMessage = queryErrors.message;
  const prsFetching = pullRequestQueries.some((query) => query.isFetching);
  const prsRequestError =
    pullRequestQueries.find((query) => isGitHubAuthenticationError(query.error))
      ?.error ?? pullRequestQueries.find((query) => query.isError)?.error;

  const refreshPullRequests = useMutation({
    mutationFn: async ({
      repositories,
      involvesMe,
    }: {
      repositories: string[];
      involvesMe: boolean;
      userId: string | null;
    }) => refreshPullRequestSummaries(repositories, involvesMe),
    onSuccess: (results, variables) => {
      // Attribute the lists to the account that requested them: this still
      // runs after an account switch has cleared the cache.
      storeRefreshedPullRequestSummaries(
        queryClient,
        variables.userId,
        variables.involvesMe,
        results
      );
      const failures = results.filter((result) => !result.success);
      if (failures.length > 0) {
        const error = failures[0].error;
        void ErrorDialog.show({
          title: 'Some pull requests could not be refreshed',
          message:
            error instanceof Error
              ? error.message
              : 'An unknown error occurred.',
          buttonText: 'OK',
        });
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

  const pullRequestMappingUrls = useMemo(
    () => pullRequests.map((pr) => pr.url),
    [pullRequests]
  );
  const pullRequestMappingsQuery = useQuery({
    queryKey: ['pull-request-issue-mappings', pullRequestMappingUrls],
    queryFn: () => listPullRequestIssueMappingsBatch(pullRequestMappingUrls),
    enabled: pullRequestMappingUrls.length > 0,
    staleTime: PR_QUERY_STALE_TIME_MS,
  });

  const pullRequestMappings = useMemo(
    () => new Map(Object.entries(pullRequestMappingsQuery.data ?? {})),
    [pullRequestMappingsQuery.data]
  );

  const loadMappedIssues = useCallback(
    async (prUrl: string) => {
      const links =
        pullRequestMappings.get(prUrl) ??
        (await queryClient.fetchQuery({
          queryKey: ['pull-request-issue-mappings', prUrl],
          queryFn: () => listPullRequestIssueMappings(prUrl),
          staleTime: PR_QUERY_STALE_TIME_MS,
        })) ??
        [];
      return Promise.all(
        links.map(async (link) => ({
          link,
          issue: await getRemoteIssue(link.issue_id),
        }))
      );
    },
    [pullRequestMappings, queryClient]
  );

  const workspaceSummaries = useMemo(
    () => [...activeWorkspaces, ...archivedWorkspaces],
    [activeWorkspaces, archivedWorkspaces]
  );

  const prefetchPullRequest = useCallback(
    (pullRequest: PullRequestSummary) =>
      queryClient.prefetchQuery({
        queryKey: ['pr-detail', pullRequest.url, 'github'],
        queryFn: () => getGitHubPullRequest(pullRequest.url),
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
        const mappedAndLocalWorkspaces = mergeMappedPullRequestWorkspaces(
          pullRequest.url,
          mappedWorkspaces,
          workspaceSummaries,
          selfHostId
        );
        if (mappedAndLocalWorkspaces.length === 0) {
          await showEmptyMapping('This pull request has no mapped workspaces.');
          return;
        }
        const selected = await selectLinkedWorkspace({
          title: 'Mapped workspaces',
          workspaces: mappedAndLocalWorkspaces,
          workspaceSummaries,
          getDescriptionPrefix: (workspace) =>
            mappedIssues.find(
              ({ link }) =>
                mappedWorkspaces.find(
                  (mappedWorkspace) =>
                    mappedWorkspace.id === workspace.id &&
                    mappedWorkspace.issue_id === link.issue_id
                ) !== undefined
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
    [
      appNavigation,
      loadMappedIssues,
      selfHostId,
      workspaces,
      workspaceSummaries,
    ]
  );

  useEffect(() => {
    if (!normalizedInitialPrUrl) {
      resolvedInitialRepositoryRef.current = undefined;
      return;
    }
    if (
      resolvedInitialRepositoryRef.current === normalizedInitialPrUrl ||
      repositories.length === 0
    ) {
      return;
    }
    resolvedInitialRepositoryRef.current = normalizedInitialPrUrl;
    const repositoryFullName = getRepositoryFullNameFromPrUrl(
      normalizedInitialPrUrl
    );
    if (!repositoryFullName) return;
    const repository = repositories.find(
      (candidate) => candidate.value === repositoryFullName
    );
    if (repository && !filters.repositories.includes(repository.value)) {
      setFilters((current) => ({
        ...current,
        repositories: [...current.repositories, repository.value],
      }));
    }
  }, [repositoriesKey, normalizedInitialPrUrl, repositories]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSelectedIndex(0);
  }, [repositoriesKey]);

  useEffect(() => {
    if (!normalizedInitialPrUrl) return;
    const index = filteredPullRequests.findIndex(
      (candidate) => candidate.url === normalizedInitialPrUrl
    );
    if (index >= 0) setSelectedIndex(index);
  }, [filteredPullRequests, normalizedInitialPrUrl]);

  useEffect(() => {
    setSelectedIndex((current) =>
      Math.min(current, Math.max(0, filteredPullRequests.length - 1))
    );
  }, [filteredPullRequests.length]);

  useEffect(() => {
    if (!isSignedIn) return;

    const openFilters = () => setFiltersOpen(true);
    const focusSearch = () => searchInputRef.current?.focus();
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
    isSignedIn,
    selectedIndex,
    selectedPullRequest,
    viewMappedWorkspaces,
  ]);

  // Command-bar "Refresh" bridge. `mutate` is referentially stable, so the
  // listener only needs re-registering when the selected repos / involvement
  // change (to force-refresh the right cache entries).
  useEffect(() => {
    const refresh = () => {
      if (!isSignedIn || filters.repositories.length === 0) return;
      refreshPullRequests.mutate({
        repositories: filters.repositories,
        involvesMe: filters.involvesMe,
        userId,
      });
    };
    window.addEventListener(PULL_REQUESTS_REFRESH_EVENT, refresh);
    return () =>
      window.removeEventListener(PULL_REQUESTS_REFRESH_EVENT, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoriesKey, filters.involvesMe, isSignedIn, userId]);

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
      appNavigation.goToPullRequests(pullRequest.url, { replace: true });
    },
    [appNavigation]
  );

  const closeDetails = useCallback(() => {
    appNavigation.goToPullRequests(undefined, { replace: true });
    window.requestAnimationFrame(() => focusRow(selectedIndex));
  }, [appNavigation, focusRow, selectedIndex]);

  const navigateDetails = useCallback(
    (direction: -1 | 1) => {
      if (!selectedPullRequest) return;
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
    },
    [
      filteredPullRequests,
      openDetails,
      prefetchPullRequest,
      selectedPullRequest,
    ]
  );

  useEffect(() => {
    if (!isActivePane || !selectedPullRequest) return;
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
  }, [closeDetails, selectedPullRequest, isActivePane]);

  useEffect(() => {
    if (
      !isActivePane ||
      !selectedPullRequest ||
      filteredPullRequests.length === 0
    )
      return;
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
      navigateDetails(event.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', handleDetailNavigation);
    return () => window.removeEventListener('keydown', handleDetailNavigation);
  }, [
    filteredPullRequests,
    navigateDetails,
    selectedPullRequest,
    isActivePane,
  ]);

  useEffect(() => {
    if (
      !isActivePane ||
      selectedPullRequest ||
      filteredPullRequests.length === 0
    )
      return;

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
    isActivePane,
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

        {isSignedIn && (
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
                  userId,
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
                  (prsFetching || refreshPullRequests.isPending) &&
                    'animate-spin'
                )}
              />
            </button>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {prsPartialError && (
          <div
            role="alert"
            className="border-b border-warning/30 bg-warning/10 px-double py-base text-sm text-normal"
          >
            Some repositories could not be loaded.
            <GitHubApiErrorAlert
              error={prsRequestError}
              fallback={prsErrorMessage ?? 'Could not load pull requests'}
            />
          </div>
        )}
        {!isAuthLoaded ? (
          <div className="flex flex-1 items-center justify-center">
            <SpinnerGapIcon className="size-icon-lg animate-spin text-low" />
          </div>
        ) : !isSignedIn ? (
          <div className="flex h-full items-center justify-center p-base">
            <LoginRequiredPrompt
              className="max-w-md"
              title="Sign in to view pull requests"
              description="Pull requests are loaded securely through your connected GitHub account."
              actionLabel="Sign in"
            />
          </div>
        ) : reposQuery.isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <SpinnerGapIcon className="size-icon-lg animate-spin text-low" />
          </div>
        ) : reposQuery.isError ? (
          <div className="flex h-full flex-col items-center justify-center px-double text-center">
            <GitPullRequestIcon className="size-8 text-low" />
            <p className="mt-base text-base font-medium text-high">
              Could not load GitHub repositories
            </p>
            <GitHubApiErrorAlert
              error={reposQuery.error}
              fallback="Could not load GitHub repositories"
              className="mt-half max-w-lg text-sm text-low"
            />
          </div>
        ) : repositories.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-double text-center text-sm text-low">
            No GitHub repositories are available for this account.
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
            <GitHubApiErrorAlert
              error={prsRequestError}
              fallback={prsErrorMessage ?? 'Could not load pull requests'}
              className="mt-half max-w-lg text-sm text-low"
            />
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
            {filteredPullRequests.map((pr, index) => {
              const mappings = pullRequestMappings.get(pr.url) ?? [];
              const issueIds = new Set(mappings.map((link) => link.issue_id));
              const hasMappedIssue = mappings.length > 0;
              const hasMappedWorkspace = hasPullRequestWorkspace(
                pr.url,
                workspaceSummaries,
                issueIds,
                workspaces
              );

              return (
                <div
                  data-pull-request-row
                  key={pr.url}
                  className={cn(
                    'flex w-full items-start pr-base hover:bg-secondary/60',
                    isNarrow && 'flex-wrap',
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
                    className={cn(
                      'flex min-w-0 items-start gap-base px-double py-base text-left',
                      isNarrow ? 'w-full' : 'flex-1'
                    )}
                  >
                    <span className="mt-half">
                      {statusIcon(pr.status, pr.is_draft)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-half">
                        <span className="break-words text-base font-medium text-high">
                          {pr.title}
                        </span>
                        {pr.is_draft && (
                          <span className="inline-flex items-center gap-1 rounded border border-border bg-panel px-half py-0.5 text-sm font-semibold uppercase tracking-wide text-normal">
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
                        <span>{pr.repository}</span>
                        <span className="rounded border border-brand/40 bg-brand/10 px-half py-0.5 text-sm font-semibold text-brand">
                          PR #{String(pr.number)}
                        </span>
                        <span>{statusLabel(pr.status)}</span>
                        <span>by {pr.author ?? 'unknown'}</span>
                        {pr.updated_at && (
                          <span>
                            updated{' '}
                            {new Date(pr.updated_at).toLocaleDateString()}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1">
                          <ChatCircleIcon className="size-icon-xs" />
                          {String(pr.comments_count)}
                        </span>
                      </span>
                    </span>
                  </button>
                  <span className="ml-auto flex shrink-0 items-center gap-half py-base">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void goToMappedIssue(pr);
                      }}
                      className={cn(
                        'flex size-8 items-center justify-center rounded text-low hover:bg-secondary hover:text-high',
                        hasMappedIssue && 'bg-brand/10 text-brand'
                      )}
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
                      className={cn(
                        'flex size-8 items-center justify-center rounded text-low hover:bg-secondary hover:text-high',
                        hasMappedWorkspace && 'bg-brand/10 text-brand'
                      )}
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
              );
            })}
          </div>
        )}
      </div>
    </main>
  );

  const selectedMappings = selectedPullRequest
    ? (pullRequestMappings.get(selectedPullRequest.url) ?? [])
    : [];
  const selectedIssueIds = new Set(
    selectedMappings.map((link) => link.issue_id)
  );
  const selectedPullRequestIndex = selectedPullRequest
    ? filteredPullRequests.findIndex(
        (pullRequest) => pullRequest.url === selectedPullRequest.url
      )
    : -1;
  const detailsContent =
    isSignedIn && selectedPullRequest ? (
      <PullRequestDetailsPanel
        prUrl={selectedPullRequest.url}
        prNumber={selectedPullRequest.number}
        onClose={closeDetails}
        onPrevious={
          isMobile || isNarrow ? () => navigateDetails(-1) : undefined
        }
        onNext={isMobile || isNarrow ? () => navigateDetails(1) : undefined}
        hasPrevious={selectedPullRequestIndex > 0}
        hasNext={
          selectedPullRequestIndex >= 0 &&
          selectedPullRequestIndex < filteredPullRequests.length - 1
        }
        onGoToMappedIssue={() => void goToMappedIssue(selectedPullRequest)}
        onViewMappedWorkspaces={() =>
          void viewMappedWorkspaces(selectedPullRequest)
        }
        hasMappedIssue={selectedMappings.length > 0}
        hasMappedWorkspace={hasPullRequestWorkspace(
          selectedPullRequest.url,
          workspaceSummaries,
          selectedIssueIds,
          workspaces
        )}
      />
    ) : null;

  const pullRequestsDefaultLayout = getPullRequestsDefaultLayout(
    detailPanelSize,
    detailsContent !== null
  );

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
            detailsContent ? 'bg-secondary' : 'bg-primary'
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
          {detailsContent && (
            <Separator
              id="pull-requests-separator"
              className="w-1 cursor-col-resize bg-panel outline-none transition-colors hover:bg-brand/50"
            />
          )}
          {detailsContent && (
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
        open={isSignedIn && filtersOpen}
        onOpenChange={setFiltersOpen}
        filters={filters}
        repositories={repositories}
        repositoryError={reposQuery.error}
        authors={authors}
        onChange={setFilters}
        onReset={() => setFilters({ ...defaultFilters })}
      />
    </>
  );
}
