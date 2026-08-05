import { repoApi } from '@/shared/lib/api';

// Client-side freshness window for PR list/detail queries, matched to the
// backend PR cache TTL (see PULL_REQUEST_CACHE_TTL_SECS).
export const PR_QUERY_STALE_TIME_MS = 60_000;

export function pullRequestSummariesQueryKey(
  repository: string,
  involvesMe: boolean
) {
  return ['pull-request-summaries', repository, involvesMe] as const;
}

export async function fetchPullRequestSummaries(
  repository: string,
  involvesMe: boolean
) {
  const result = await repoApi.listPullRequestSummaries(repository, involvesMe);
  if (!result.success) {
    throw new Error(result.message || 'Failed to load pull requests');
  }
  return result.data;
}

export function pullRequestSummariesQueryOptions(
  repository: string,
  involvesMe: boolean
) {
  return {
    queryKey: pullRequestSummariesQueryKey(repository, involvesMe),
    queryFn: () => fetchPullRequestSummaries(repository, involvesMe),
    staleTime: PR_QUERY_STALE_TIME_MS,
    gcTime: 60 * 60_000,
  };
}
