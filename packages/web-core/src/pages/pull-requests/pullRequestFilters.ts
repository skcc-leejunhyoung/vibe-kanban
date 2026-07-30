import type { MergeStatus } from 'shared/types';

export type PullRequestStatusFilter = 'all' | MergeStatus;
export type PullRequestDraftFilter = 'all' | 'draft' | 'ready';
export type PullRequestUpdatedFilter = 'all' | 'day' | 'week' | 'month';

export type PullRequestFilterState = {
  repository: string;
  status: PullRequestStatusFilter;
  author: string;
  draft: PullRequestDraftFilter;
  updated: PullRequestUpdatedFilter;
  involvesMe: boolean;
};

export const DEFAULT_PULL_REQUEST_FILTER_STATE: PullRequestFilterState = {
  repository: 'all',
  status: 'all',
  author: 'all',
  draft: 'all',
  updated: 'all',
  involvesMe: false,
};

export function resolvePullRequestFiltersAfterDefaultsChange(
  current: PullRequestFilterState,
  previousDefaults: PullRequestFilterState,
  nextDefaults: PullRequestFilterState
): PullRequestFilterState {
  const stillUsingPreviousDefaults = (
    Object.keys(previousDefaults) as Array<keyof PullRequestFilterState>
  ).every((key) => current[key] === previousDefaults[key]);

  return stillUsingPreviousDefaults ? { ...nextDefaults } : current;
}

export const PULL_REQUESTS_OPEN_FILTERS_EVENT =
  'vibe:pull-requests-open-filters';
export const PULL_REQUESTS_FOCUS_SEARCH_EVENT =
  'vibe:pull-requests-focus-search';
export const PULL_REQUESTS_SELECT_REPOSITORY_EVENT =
  'vibe:pull-requests-select-repository';
export const PULL_REQUESTS_GOTO_MAPPED_ISSUE_EVENT =
  'vibe:pull-requests-goto-mapped-issue';
export const PULL_REQUESTS_VIEW_MAPPED_WORKSPACES_EVENT =
  'vibe:pull-requests-view-mapped-workspaces';
