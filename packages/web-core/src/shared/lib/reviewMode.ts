import type { Tag } from 'shared/remote-types';
import type { PrReviewInput, PullRequestDetail } from 'shared/types';

/**
 * Tag name that opts an issue's workspace into review mode: the workspace works
 * directly on the issue's open PR head branch instead of a new `vk/` branch.
 * Matches the backend's `REVIEW_TAG_NAME`.
 */
export const REVIEW_TAG_NAME = 'review';

/**
 * Whether any of the issue's tags is the `review` tag. Normalized (trim +
 * lowercase) to match the backend's case-insensitive comparison.
 */
export function hasReviewTag(tags: Tag[]): boolean {
  return tags.some((tag) => tag.name.trim().toLowerCase() === REVIEW_TAG_NAME);
}

/**
 * Find the open PR (carrying head-branch detail) that corresponds to one of the
 * issue's linked PRs, matched by URL. Returns null when none of the issue's PRs
 * are currently open for this repo.
 */
export function findOpenPrDetailForIssue(
  openPrs: PullRequestDetail[],
  issuePrUrls: string[]
): PullRequestDetail | null {
  const urls = new Set(issuePrUrls);
  return openPrs.find((pr) => pr.status === 'open' && urls.has(pr.url)) ?? null;
}

/** Assemble the backend `pr_review` payload from a resolved open-PR detail. */
export function buildPrReviewInput(
  repoId: string,
  detail: PullRequestDetail,
  remoteName: string | null
): PrReviewInput {
  return {
    repo_id: repoId,
    pr_number: detail.number,
    pr_title: detail.title,
    pr_url: detail.url,
    head_branch: detail.head_branch,
    base_branch: detail.base_branch,
    remote_name: remoteName,
  };
}

/**
 * Instruction appended below the user's prompt when a workspace is created in
 * review mode, telling the agent to review the resolved PR.
 */
export const REVIEW_PROMPT_INSTRUCTION = 'Review the checked-out PR.';

/**
 * Append the review instruction below the user's prompt. Only used when review
 * mode is actually active (a `pr_review` payload is being sent).
 */
export function appendReviewInstruction(message: string): string {
  const base = message.trimEnd();
  return base.length > 0
    ? `${base}\n\n${REVIEW_PROMPT_INSTRUCTION}`
    : REVIEW_PROMPT_INSTRUCTION;
}

/**
 * Resolve review mode from already-fetched data. Returns the `pr_review` payload
 * when the issue is review-tagged AND has an open PR for the repo, otherwise
 * null (→ normal new-branch workspace creation).
 */
export function resolveReviewMode(args: {
  tags: Tag[];
  openPrs: PullRequestDetail[];
  issuePrUrls: string[];
  repoId: string;
  remoteName: string | null;
}): PrReviewInput | null {
  if (!hasReviewTag(args.tags)) return null;
  const detail = findOpenPrDetailForIssue(args.openPrs, args.issuePrUrls);
  if (!detail) return null;
  return buildPrReviewInput(args.repoId, detail, args.remoteName);
}
