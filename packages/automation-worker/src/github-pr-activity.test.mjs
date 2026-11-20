import assert from 'node:assert/strict';
import test from 'node:test';

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import {
  isNotifiableReview,
  mapWithConcurrency,
  PR_HEALTH_QUERY,
  prHealthSearchQuery,
  prHealthSignals,
  recentlyUpdatedPrs,
  reviewActivity,
} from './github-pr-activity.mjs';
import { automationEventKey } from './routines.mjs';
import { prHealthEvent } from './vibe-events.mjs';

const review = {
  id: 1234567890,
  state: 'APPROVED',
  body: 'Looks good.',
  submitted_at: '2026-07-27T10:10:20Z',
  html_url:
    'https://github.com/example-org/example-repo/pull/42#pullrequestreview-1234567890',
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

test('accepts status-only reviews and preserves the original payload', () => {
  for (const [state, expected] of [
    ['APPROVED', '승인 (본문 없음)'],
    ['CHANGES_REQUESTED', '변경 요청 (본문 없음)'],
    ['approved', '승인 (본문 없음)'],
  ]) {
    for (const body of ['', ' \n\t', null, undefined]) {
      const input = { ...review, state, body };
      assert.equal(isNotifiableReview(input, 'me', review.submitted_at), true);
      const activity = reviewActivity(input);
      assert.equal(activity.body, expected);
      assert.equal(activity.review_state, state.toLowerCase());
      assert.equal(activity.raw, input);
      assert.equal(input.body, body);
    }
    const input = { ...review, state, body: '  Original body\n' };
    assert.equal(reviewActivity(input).body, input.body);
  }
});

test('requires a body only for commented reviews', () => {
  for (const body of ['', ' \n\t', null, undefined]) {
    assert.equal(
      isNotifiableReview({ ...review, state: 'COMMENTED', body }, 'me', ''),
      false,
    );
  }
  const input = { ...review, state: 'COMMENTED' };
  assert.equal(isNotifiableReview(input, 'me', ''), true);
  assert.equal(reviewActivity(input).body, review.body);
});

test('rejects self-authored, unsupported, invalid-date, and old status-only reviews', () => {
  for (const state of ['APPROVED', 'CHANGES_REQUESTED']) {
    const input = { ...review, state, body: '' };
    assert.equal(
      isNotifiableReview({ ...input, user: { login: 'me' } }, 'me', ''),
      false,
    );
    assert.equal(
      isNotifiableReview(input, 'me', '2026-07-27T10:10:21Z'),
      false,
    );
    assert.equal(
      isNotifiableReview({ ...input, submitted_at: 'invalid' }, 'me', ''),
      false,
    );
  }
  for (const state of ['PENDING', 'DISMISSED', '', 'UNKNOWN']) {
    assert.equal(isNotifiableReview({ ...review, state }, 'me', ''), false);
  }
  assert.equal(isNotifiableReview(null, 'me', ''), false);
  assert.equal(
    isNotifiableReview({ ...review, user: { login: 'me' } }, 'me', ''),
    false,
  );
  assert.equal(
    isNotifiableReview({ ...review, state: 'PENDING' }, 'me', ''),
    false,
  );
  assert.equal(isNotifiableReview(review, 'me', '2026-07-27T10:10:21Z'), false);
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

const HEAD = 'a'.repeat(40);
function healthPr(overrides = {}, state = 'FAILURE', oid = HEAD) {
  return {
    number: 7,
    url: 'https://github.com/Acme/Widgets/pull/7',
    isDraft: false,
    headRefOid: HEAD,
    mergeable: 'MERGEABLE',
    repository: { nameWithOwner: 'Acme/Widgets' },
    commits: { nodes: [{ commit: { oid, statusCheckRollup: state && { state } } }] },
    ...overrides,
  };
}

test('PR health signals: failing head checks and base conflicts only', () => {
  assert.deepEqual(prHealthSignals(healthPr()), ['checks_failed']);
  assert.deepEqual(prHealthSignals(healthPr({}, 'ERROR')), ['checks_failed']);
  assert.deepEqual(prHealthSignals(healthPr({ mergeable: 'CONFLICTING' }, 'SUCCESS')), ['merge_conflict']);
  assert.deepEqual(prHealthSignals(healthPr({ mergeable: 'CONFLICTING' })), ['checks_failed', 'merge_conflict']);
  for (const quiet of [
    healthPr({}, 'PENDING'),
    healthPr({}, null), // no checks at all
    healthPr({}, 'FAILURE', 'b'.repeat(40)), // rollup of an older commit
    healthPr({ mergeable: 'UNKNOWN' }, 'SUCCESS'), // not computed yet
    healthPr({ isDraft: true, mergeable: 'CONFLICTING' }),
    healthPr({ headRefOid: null }),
  ])
    assert.deepEqual(prHealthSignals(quiet), []);
});

test('PR health search covers own open PRs, optionally per repository', () => {
  assert.equal(prHealthSearchQuery('me'), 'is:pr is:open archived:false author:me');
  assert.equal(
    prHealthSearchQuery('me', ['acme/a', 'acme/b']),
    'is:pr is:open archived:false author:me repo:acme/a repo:acme/b',
  );
  assert.match(PR_HEALTH_QUERY, /statusCheckRollup\{state\}/);
  assert.match(PR_HEALTH_QUERY, /mergeable/);
});

// The production poller, run against a fake GraphQL search and dispatcher.
const serverSource = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
function productionFunction(name) {
  const match = new RegExp(`^async function ${name}\\(`, 'm').exec(serverSource);
  assert.ok(match, `Missing production function ${name}`);
  return serverSource.slice(match.index, serverSource.indexOf('\n}\n', match.index) + 2);
}

const plain = (value) => JSON.parse(JSON.stringify(value)); // vm-realm objects

function healthHarness() {
  const h = {
    nodes: [],
    queries: [],
    dispatched: [],
    failDispatch: false,
    connector: { id: 'github-default', config: { owner: 'acme', repo: 'widgets' } },
  };
  h.context = vm.createContext({
    Date,
    Set,
    state: { eventReceipts: {} },
    PR_HEALTH_QUERY,
    prHealthSearchQuery,
    prHealthSignals,
    prHealthEvent,
    automationEventKey,
    githubReviewRepositories: (config) => config.reviewRepositories,
    githubGraphql: async (_connector, query, variables) => {
      assert.equal(query, PR_HEALTH_QUERY);
      h.queries.push(variables.q);
      return { search: { nodes: h.nodes } };
    },
    processAutomationEvent: async (key, event) => {
      if (h.failDispatch) throw new Error('routine unavailable');
      h.context.state.eventReceipts[key] = { status: 'succeeded' };
      h.dispatched.push(event);
    },
    persistState: async () => {},
  });
  vm.runInContext(productionFunction('pollGithubPrHealth'), h.context);
  h.poll = () => h.context.pollGithubPrHealth(h.connector, 'me');
  return h;
}

test('PR health poll seeds existing failures, then wakes once per head', async () => {
  const h = healthHarness();
  h.nodes = [healthPr()];
  await h.poll(); // first poll: already failing, recorded without a wake
  assert.equal(h.dispatched.length, 0);
  assert.ok(h.connector.config.prHealthSeededAt);
  assert.equal(h.queries[0], 'is:pr is:open archived:false author:me');

  await h.poll();
  assert.equal(h.dispatched.length, 0, 'the seeded head never wakes');

  h.context.state.eventReceipts = {}; // a week later the receipts are pruned
  await h.poll();
  assert.equal(h.dispatched.length, 0, 'a long-failing seeded head stays quiet');

  const next = 'c'.repeat(40);
  h.nodes = [healthPr({ headRefOid: next, mergeable: 'CONFLICTING' }, 'FAILURE', next)];
  h.failDispatch = true;
  await assert.rejects(h.poll(), /routine unavailable/);
  h.failDispatch = false;
  await h.poll(); // a failed hand-off is retried on the next poll
  await h.poll();
  assert.deepEqual(
    h.dispatched.map((event) => [event.kind, event.id]),
    [
      ['pr.checks_failed', `github-checks_failed:acme/widgets#7:${next}`],
      ['pr.merge_conflict', `github-merge_conflict:acme/widgets#7:${next}`],
    ],
  );
  assert.equal(h.dispatched[0].data.pr_url, 'https://github.com/Acme/Widgets/pull/7');

  const failing = h.nodes;
  h.nodes = []; // one search result without the PR keeps its row
  await h.poll();
  h.nodes = failing;
  await h.poll();
  assert.equal(h.dispatched.length, 2, 'no second wake for the same head');
  const row = plain(h.connector.config.prHealthHeads)['acme/widgets#7'];
  assert.deepEqual([row.checks_failed, row.merge_conflict], [[HEAD, next], [next]]);

  h.context.state.eventReceipts = {};
  h.nodes = [healthPr()]; // head returns to the earlier SHA after receipt expiry
  await h.poll();
  assert.equal(h.dispatched.length, 2, 'the earlier head does not wake again');

  h.nodes = []; // gone for more than three days (closed, or out of scope): the row goes
  h.connector.config.prHealthHeads['acme/widgets#7'].seenAt -= 3 * 24 * 60 * 60 * 1000 + 1;
  await h.poll();
  assert.deepEqual(plain(h.connector.config.prHealthHeads), {});
});

test('a seeded head missing from one search does not wake when it returns', async () => {
  const h = healthHarness();
  h.nodes = [healthPr()];
  await h.poll(); // seed
  h.nodes = [];
  await h.poll();
  h.nodes = [healthPr()];
  await h.poll();
  assert.equal(h.dispatched.length, 0);
});

test('PR health poll keeps its rows when the search answer is malformed', async () => {
  const h = healthHarness();
  h.connector.config.prHealthSeededAt = '2026-01-01T00:00:00.000Z';
  h.connector.config.prHealthHeads = { 'acme/widgets#7': { checks_failed: HEAD, seenAt: 1 } };
  h.context.githubGraphql = async () => ({});
  await assert.rejects(h.poll(), /no nodes/);
  assert.deepEqual(h.connector.config.prHealthHeads, { 'acme/widgets#7': { checks_failed: HEAD, seenAt: 1 } });
});

test('PR health poll follows the PR activity scope and can be switched off', async () => {
  const h = healthHarness();
  h.connector.config.reviewRepositories = ['acme/other'];
  await h.poll();
  assert.equal(h.queries[0], 'is:pr is:open archived:false author:me repo:acme/widgets');
  h.connector.config.reviewPrs = true;
  await h.poll();
  assert.equal(h.queries[1], 'is:pr is:open archived:false author:me repo:acme/widgets repo:acme/other');
  h.connector.config.watchPrHealth = false;
  await h.poll();
  assert.equal(h.queries.length, 2);
});
