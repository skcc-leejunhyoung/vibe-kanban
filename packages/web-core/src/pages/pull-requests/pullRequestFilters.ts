import type { MergeStatus } from 'shared/types';

export type PullRequestStatusFilter = 'all' | MergeStatus;
export type PullRequestDraftFilter = 'all' | 'draft' | 'ready';
export type PullRequestUpdatedFilter = 'all' | 'day' | 'week' | 'month';

export type PullRequestFilterState = {
  repositories: string[];
  status: PullRequestStatusFilter;
  author: string;
  draft: PullRequestDraftFilter;
  updated: PullRequestUpdatedFilter;
  involvesMe: boolean;
};

export const DEFAULT_PULL_REQUEST_FILTER_STATE: PullRequestFilterState = {
  repositories: [],
  status: 'all',
  author: 'all',
  draft: 'all',
  updated: 'all',
  involvesMe: false,
};

function filterValuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
  }
  return a === b;
}

export function resolvePullRequestFiltersAfterDefaultsChange(
  current: PullRequestFilterState,
  previousDefaults: PullRequestFilterState,
  nextDefaults: PullRequestFilterState
): PullRequestFilterState {
  // Repository selection is driven by the page itself (deep links to a PR,
  // pruning removed repos), not by the default "refinement" filters. Ignore it
  // when deciding whether the user diverged from the defaults — otherwise a
  // deep link that auto-selects a repo before the server-saved defaults finish
  // loading looks like a manual edit and blocks those defaults from applying.
  const stillUsingPreviousDefaults = (
    Object.keys(previousDefaults) as Array<keyof PullRequestFilterState>
  ).every(
    (key) =>
      key === 'repositories' ||
      filterValuesEqual(current[key], previousDefaults[key])
  );

  if (!stillUsingPreviousDefaults) return current;

  // Keep repositories already picked (deep link / manual selection); only fall
  // back to the default repositories when nothing is selected yet, so the
  // saved default repos apply on a fresh open even if they load late.
  return {
    ...nextDefaults,
    repositories:
      current.repositories.length > 0
        ? current.repositories
        : nextDefaults.repositories,
  };
}

export const PULL_REQUESTS_OPEN_FILTERS_EVENT =
  'vibe:pull-requests-open-filters';
export const PULL_REQUESTS_FOCUS_SEARCH_EVENT =
  'vibe:pull-requests-focus-search';
export const PULL_REQUESTS_REFRESH_EVENT = 'vibe:pull-requests-refresh';
export const PULL_REQUESTS_GOTO_MAPPED_ISSUE_EVENT =
  'vibe:pull-requests-goto-mapped-issue';
export const PULL_REQUESTS_VIEW_MAPPED_WORKSPACES_EVENT =
  'vibe:pull-requests-view-mapped-workspaces';
export const PULL_REQUESTS_OPEN_IN_WEB_EVENT = 'vibe:pull-requests-open-in-web';
