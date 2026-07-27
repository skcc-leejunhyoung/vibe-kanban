import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isNotifiableReview,
  mapWithConcurrency,
  recentlyUpdatedPrs,
  reviewActivity,
} from './github-pr-activity.mjs';

const review = {
  id: 1234567890,
  state: 'APPROVED',
  body: 'Looks good.',
  submitted_at: '2026-07-27T10:10:20Z',
  html_url: 'https://github.com/example-org/example-repo/pull/42#pullrequestreview-1234567890',
  url: 'https://api.github.com/repos/example-org/example-repo/pulls/42/reviews/1234567890',
  user: { login: 'reviewer' },
};

test('accepts a non-empty review from another user at the poll boundary', () => {
  assert.equal(
    isNotifiableReview(review, 'current-user', '2026-07-27T10:10:20Z'),
    true,
  );
  assert.deepEqual(reviewActivity(review), {
    id: review.id,
    url: review.url || review.html_url,
    html_url: review.html_url,
    user: review.user,
    body: review.body,
    created_at: review.submitted_at,
    review_state: 'approved',
    raw: review,
  });
});

test('rejects empty, self-authored, pending, and old reviews', () => {
  assert.equal(isNotifiableReview({ ...review, body: '' }, 'me', ''), false);
  assert.equal(
    isNotifiableReview({ ...review, user: { login: 'me' } }, 'me', ''),
    false,
  );
  assert.equal(isNotifiableReview({ ...review, state: 'PENDING' }, 'me', ''), false);
  assert.equal(
    isNotifiableReview(review, 'me', '2026-07-27T10:10:21Z'),
    false,
  );
});

test('selects only PRs updated inside the overlap window', () => {
  assert.deepEqual(
    recentlyUpdatedPrs(
      [
        { number: 1, updated_at: '2026-07-27T10:04:59Z' },
        { number: 2, updated_at: '2026-07-27T10:05:00Z' },
      ],
      '2026-07-27T10:05:00Z',
    ).map((pr) => pr.number),
    [2],
  );
});

test('bounds concurrent review requests while preserving result order', async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 2;
  });

  assert.equal(maximum, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
});
