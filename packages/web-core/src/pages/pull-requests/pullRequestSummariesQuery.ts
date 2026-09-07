import { listGitHubPullRequests } from '@/shared/lib/remoteApi';

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
