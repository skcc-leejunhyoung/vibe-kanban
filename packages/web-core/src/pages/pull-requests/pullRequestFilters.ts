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
  involvesMe: true,
};

export const PULL_REQUESTS_OPEN_FILTERS_EVENT =
  'vibe:pull-requests-open-filters';
export const PULL_REQUESTS_FOCUS_SEARCH_EVENT =
  'vibe:pull-requests-focus-search';
