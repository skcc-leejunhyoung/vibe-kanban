const NOTIFIABLE_REVIEW_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
]);

export function isNotifiableReview(review, login, since) {
  const state = String(review?.state || '').toUpperCase();
  if (!review || !NOTIFIABLE_REVIEW_STATES.has(state)) {
    return false;
  }
  if (state === 'COMMENTED' && !String(review.body || '').trim()) return false;
  if (review.user && review.user.login === login) return false;

  const submittedAt = Date.parse(String(review.submitted_at || ''));
  const sinceAt = Date.parse(String(since || ''));
  return (
    Number.isFinite(submittedAt) &&
    (!Number.isFinite(sinceAt) || submittedAt >= sinceAt)
  );
}

export function reviewActivity(review) {
  const state = String(review.state || '').toLowerCase();
  const fallbackBody =
    state === 'approved'
      ? '승인 (본문 없음)'
      : state === 'changes_requested'
        ? '변경 요청 (본문 없음)'
        : '';
  return {
    id: review.id,
    url: review.url || review.html_url,
    html_url: review.html_url,
    user: review.user,
    body: String(review.body || '').trim() ? review.body : fallbackBody,
    created_at: review.submitted_at,
    review_state: state,
    raw: review,
  };
}

// The account's own open PRs with what auto-fix reacts to: the head's check
// rollup and whether the base now conflicts. One GraphQL search per poll.
export const PR_HEALTH_QUERY = `query($q:String!){search(query:$q,type:ISSUE,first:100){nodes{...on PullRequest{number url isDraft headRefOid mergeable repository{nameWithOwner} commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}}}}}`;

// ponytail: one page of 100 open PRs; paginate if an account ever has more.
export function prHealthSearchQuery(login, repositories = []) {
  return [
    'is:pr is:open archived:false',
    `author:${login}`,
    ...repositories.map((repository) => `repo:${repository}`),
  ].join(' ');
}

// `checks_failed` only for the current head (an older commit's rollup says
// nothing about the PR now). GitHub reports `mergeable: UNKNOWN` until it has
// computed it; that is no signal. Drafts are work in progress.
export function prHealthSignals(pr) {
  if (!pr?.headRefOid || pr.isDraft) return [];
  const commit = pr.commits?.nodes?.[0]?.commit;
  const signals = [];
  if (
    commit?.oid === pr.headRefOid &&
    ['FAILURE', 'ERROR'].includes(commit.statusCheckRollup?.state)
  )
    signals.push('checks_failed');
  if (pr.mergeable === 'CONFLICTING') signals.push('merge_conflict');
  return signals;
}

export function recentlyUpdatedPrs(prs, since) {
  const sinceAt = Date.parse(String(since || ''));
  if (!Number.isFinite(sinceAt)) return prs;
  return prs.filter((pr) => {
    const updatedAt = Date.parse(String(pr.updated_at || ''));
    return Number.isFinite(updatedAt) && updatedAt >= sinceAt;
  });
}

export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}
