import type { QueryClient } from '@tanstack/react-query';
import { listGitHubPullRequests } from '@/shared/lib/remoteApi';

// Client-side freshness window for PR list/detail queries, matched to the
// backend PR cache TTL (see PULL_REQUEST_CACHE_TTL_SECS).
export const PR_QUERY_STALE_TIME_MS = 60_000;

// The lists are account-specific (private repositories, "involves me"), so the
// key carries the requesting user. A refresh that completes after an account
// switch then lands under the previous user's key, never the next user's.
export function pullRequestSummariesQueryKey(
  userId: string | null,
  repository: string,
  involvesMe: boolean
) {
  return ['pull-request-summaries', userId, repository, involvesMe] as const;
}

export async function fetchPullRequestSummaries(
  repository: string,
  involvesMe: boolean,
  refresh = false
) {
  const summaries = await listGitHubPullRequests(
    repository,
    involvesMe,
    refresh
  );
  return { summaries };
}

export type PullRequestRefreshResult =
  | {
      repository: string;
      success: true;
      result: Awaited<ReturnType<typeof fetchPullRequestSummaries>>;
    }
  | { repository: string; success: false; error: unknown };

export async function refreshPullRequestSummaries(
  repositories: string[],
  involvesMe: boolean
): Promise<PullRequestRefreshResult[]> {
  return Promise.all(
    repositories.map(async (repository) => {
      try {
        return {
          repository,
          success: true,
          result: await fetchPullRequestSummaries(repository, involvesMe, true),
        } as const;
      } catch (error) {
        return { repository, success: false, error } as const;
      }
    })
  );
}

export function pullRequestSummariesQueryOptions(
  userId: string | null,
  repository: string,
  involvesMe: boolean
) {
  return {
    queryKey: pullRequestSummariesQueryKey(userId, repository, involvesMe),
    queryFn: () => fetchPullRequestSummaries(repository, involvesMe),
    staleTime: PR_QUERY_STALE_TIME_MS,
    gcTime: 60 * 60_000,
  };
}

/**
 * Stores refreshed lists for the user who requested them. The mutation
 * callback still runs after an account switch has cleared the cache.
 */
export function storeRefreshedPullRequestSummaries(
  queryClient: QueryClient,
  userId: string | null,
  involvesMe: boolean,
  results: PullRequestRefreshResult[]
): void {
  for (const result of results) {
    if (!result.success) continue;
    queryClient.setQueryData(
      pullRequestSummariesQueryKey(userId, result.repository, involvesMe),
      result.result
    );
  }
}

export function summarizePullRequestQueryErrors(
  queries: ReadonlyArray<{
    isError: boolean;
    isSuccess: boolean;
    error: Error | null;
  }>
): { allFailed: boolean; partiallyFailed: boolean; message?: string } {
  const errors = queries.filter((query) => query.isError);
  return {
    allFailed: queries.length > 0 && errors.length === queries.length,
    partiallyFailed:
      errors.length > 0 && queries.some((query) => query.isSuccess),
    message: errors[0]?.error?.message,
  };
}
