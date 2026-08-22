import { useContext, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ProjectContext } from '@/shared/hooks/useProjectContext';
import { issuePrsApi } from '@/shared/lib/api';
import { hasReviewTag, resolveReviewMode } from '@/shared/lib/reviewMode';
import type { PrReviewInput, PullRequestDetail } from 'shared/types';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';

interface LinkedIssueLike {
  issueId: string;
  remoteProjectId: string;
}

export interface ReviewModeState {
  /** The linked issue carries the `review` tag, so review mode is offered. */
  reviewTagPresent: boolean;
  /** An open PR for the selected repo was resolved (review mode is possible). */
  resolved: boolean;
  /** Still fetching the repo's open PRs. */
  isResolving: boolean;
  /** Head (feature) branch of the resolved PR, for display. */
  headBranch: string | null;
  /** Number of the resolved PR, for display. */
  prNumber: number | null;
  /** User toggle; default on. Off → fall back to normal new-branch creation. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /**
   * Effective `pr_review` payload to send: the resolved input when review mode
   * is enabled and a PR was resolved, otherwise null (normal `vk/` branch).
   */
  prReviewPayload: PrReviewInput | null;
}

/**
 * Resolves whether a workspace being created from `linkedIssue` should run in
 * review mode (work directly on the issue's open PR head branch). Safe to call
 * outside a ProjectProvider — it simply reports `reviewTagPresent: false`.
 */
export function useReviewMode(
  linkedIssue: LinkedIssueLike | null,
  repoId: string | undefined
): ReviewModeState {
  // Read the project context defensively: the create UI is also reachable
  // outside a project (no linked issue), where the provider is absent.
  const projectCtx = useContext(ProjectContext);
  const hostId = useHostId();
  const [enabled, setEnabled] = useState(true);

  const issueId = linkedIssue?.issueId ?? null;

  const tags = useMemo(
    () =>
      projectCtx && issueId ? projectCtx.getTagObjectsForIssue(issueId) : [],
    [projectCtx, issueId]
  );
  const reviewTagPresent = useMemo(() => hasReviewTag(tags), [tags]);

  const issuePrUrls = useMemo(
    () =>
      projectCtx && issueId
        ? projectCtx.getPullRequestsForIssue(issueId).map((pr) => pr.url)
        : [],
    [projectCtx, issueId]
  );

  // Resolve regardless of the toggle so the banner can show the PR even when
  // the user has flipped review mode off.
  const canResolve = reviewTagPresent && !!repoId && issuePrUrls.length > 0;

  const prQueries = useQueries({
    queries: issuePrUrls.map((url) => ({
      queryKey: ['review-mode-pr', url, getHostRequestScopeQueryKey(hostId)],
      queryFn: () => issuePrsApi.getPrInfo(url, hostId),
      enabled: canResolve,
      staleTime: 30_000,
    })),
  });

  const linkedPrs = useMemo<PullRequestDetail[]>(
    () =>
      prQueries.flatMap((query) =>
        query.data?.success === true ? [query.data.data] : []
      ),
    [prQueries]
  );
  const isFetching = prQueries.some((query) => query.isFetching);

  const resolvedReview = useMemo(() => {
    if (!canResolve) return null;
    return resolveReviewMode({
      tags,
      openPrs: linkedPrs,
      issuePrUrls,
      repoId: repoId!,
      remoteName: null,
    });
  }, [canResolve, tags, linkedPrs, issuePrUrls, repoId]);

  return {
    reviewTagPresent,
    resolved: resolvedReview !== null,
    isResolving: canResolve && isFetching,
    headBranch: resolvedReview?.head_branch ?? null,
    prNumber: resolvedReview ? Number(resolvedReview.pr_number) : null,
    enabled,
    setEnabled,
    prReviewPayload: enabled ? resolvedReview : null,
  };
}
