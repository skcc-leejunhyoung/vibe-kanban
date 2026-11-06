import { useContext, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ProjectContext } from '@/shared/hooks/useProjectContext';
import { issuePrsApi } from '@/shared/lib/api';
import { hasReviewTag, resolveReviewMode } from '@/shared/lib/reviewMode';
import type { PrReviewInput, PullRequestDetail } from 'shared/types';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { getAuthErrorKind } from '@/shared/lib/auth/errors';

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
  blocked: boolean;
  canToggle: boolean;
  requiresLogin: boolean;
  error: unknown;
  status:
    | 'normal'
    | 'loading'
    | 'error'
    | 'repository-required'
    | 'ready'
    | 'no-pr'
    | 'disabled';
  retry: () => void;
}

/**
 * Resolves whether a workspace being created from `linkedIssue` should run in
 * review mode (work directly on the issue's open PR head branch). Safe to call
 * without a linked issue. A linked issue needs its matching project context.
 */
export function useReviewMode(
  linkedIssue: LinkedIssueLike | null,
  repoId: string | undefined
): ReviewModeState {
  // Read the project context defensively: the create UI is also reachable
  // outside a project (no linked issue), where the provider is absent.
  const context = useContext(ProjectContext);
  const projectCtx =
    context?.projectId === linkedIssue?.remoteProjectId ? context : null;
  const hostId = useHostId();
  const scope = JSON.stringify([
    linkedIssue?.remoteProjectId,
    linkedIssue?.issueId,
    getHostRequestScopeQueryKey(hostId),
  ]);
  const [selection, setSelection] = useState({ scope, enabled: true });
  if (selection.scope !== scope) setSelection({ scope, enabled: true });
  const enabled = selection.scope === scope ? selection.enabled : true;

  const issueId = linkedIssue?.issueId ?? null;

  const tags = useMemo(
    () =>
      projectCtx && issueId ? projectCtx.getTagObjectsForIssue(issueId) : [],
    [projectCtx, issueId]
  );
  const reviewTagPresent = useMemo(() => hasReviewTag(tags), [tags]);

  const issuePrs = useMemo(
    () =>
      projectCtx && issueId ? projectCtx.getPullRequestsForIssue(issueId) : [],
    [projectCtx, issueId]
  );

  // Resolve regardless of the toggle so the banner can show the PR even when
  // the user has flipped review mode off.
  const tagsSource = projectCtx?.reviewTags;
  const prsSource = projectCtx?.reviewPullRequests;
  const tagsReady = !!tagsSource && !tagsSource.isLoading && !tagsSource.error;
  const prsReady = !!prsSource && !prsSource.isLoading && !prsSource.error;
  const canResolve =
    tagsReady &&
    prsReady &&
    reviewTagPresent &&
    !!repoId &&
    issuePrs.length > 0;

  const prQueries = useQueries({
    queries: issuePrs.map(({ url }) => ({
      queryKey: ['review-mode-pr', url, getHostRequestScopeQueryKey(hostId)],
      queryFn: () => issuePrsApi.getPrInfo(url, hostId),
      enabled: canResolve,
      staleTime: 30_000,
    })),
  });

  const linkedPrs = useMemo<PullRequestDetail[]>(
    () =>
      prQueries.flatMap((query) =>
        !query.isError && query.data?.success === true ? [query.data.data] : []
      ),
    [prQueries]
  );
  // A live open PR need not wait for inaccessible historical PRs.
  const hasOpenPr = linkedPrs.some((pr) => pr.status === 'open');
  const requiredQueries = prQueries.filter(
    (_, index) =>
      !hasOpenPr || !['closed', 'merged'].includes(issuePrs[index].status)
  );
  const detailError = canResolve
    ? (requiredQueries.find((query) => query.isError)?.error ??
      requiredQueries.flatMap((query) =>
        query.data?.success === false
          ? [new Error(query.data.message ?? 'PR lookup failed')]
          : []
      )[0])
    : null;
  const error =
    tagsSource?.error ||
    (reviewTagPresent && (prsSource?.error || detailError)) ||
    null;
  const detailsPending =
    canResolve && requiredQueries.some((query) => !query.data);

  const resolvedReview = useMemo(() => {
    if (!canResolve || error || detailsPending) return null;
    return resolveReviewMode({
      tags,
      openPrs: linkedPrs,
      // Each detail was fetched from one of the issue's PR urls, and gh reports
      // a renamed or transferred repository's PR under its current url.
      issuePrUrls: linkedPrs.map((pr) => pr.url),
      repoId: repoId!,
      remoteName: null,
    });
  }, [canResolve, error, detailsPending, tags, linkedPrs, repoId]);

  let status: ReviewModeState['status'];
  if (!linkedIssue) status = 'normal';
  else if (!enabled) status = 'disabled';
  else if (!projectCtx || error) status = 'error';
  else if (!tagsReady) status = 'loading';
  else if (!reviewTagPresent) status = 'normal';
  else if (!repoId) status = 'repository-required';
  else if (!prsReady || detailsPending) status = 'loading';
  else status = resolvedReview ? 'ready' : 'no-pr';

  const canToggle = tagsReady && reviewTagPresent;
  const retry = () => {
    if (!tagsReady) tagsSource?.retry();
    if (reviewTagPresent && !prsReady) prsSource?.retry();
    if (canResolve)
      for (const query of prQueries) {
        if (query.isError || query.data?.success === false || !query.data)
          void query.refetch();
      }
  };

  return {
    reviewTagPresent,
    resolved: resolvedReview !== null,
    isResolving: status === 'loading',
    headBranch: resolvedReview?.head_branch ?? null,
    prNumber: resolvedReview ? Number(resolvedReview.pr_number) : null,
    enabled,
    setEnabled: (next) => {
      if (next || canToggle) setSelection({ scope, enabled: next });
    },
    prReviewPayload: status === 'ready' ? resolvedReview : null,
    blocked:
      status === 'loading' ||
      status === 'error' ||
      status === 'repository-required',
    canToggle,
    requiresLogin:
      Boolean(tagsSource?.error || prsSource?.error) &&
      getAuthErrorKind(tagsSource?.error || prsSource?.error) === 'required',
    error,
    status,
    retry,
  };
}
