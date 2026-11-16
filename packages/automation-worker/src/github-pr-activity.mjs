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
