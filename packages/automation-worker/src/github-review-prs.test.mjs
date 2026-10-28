import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  githubReviewRepositories,
  searchGithubPrs,
  reconcileGithubReviewPrs,
} from './github-review-prs.mjs';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/review-request.json', import.meta.url))
);
const repository = 'example/search';
const pr = { ...fixture.searchItem, repository };
const head = {
  headRef: fixture.details.head.ref,
  headSha: fixture.details.head.sha,
  baseRef: fixture.details.base.ref,
};

test('uses only explicitly selected repositories, normalizes duplicates, rejects search qualifiers', () => {
  assert.deepEqual(githubReviewRepositories({ owner: 'example', repo: 'app' }), [
    'example/app',
  ]);
  assert.deepEqual(
    githubReviewRepositories({
      reviewRepositories: ['example/app', 'EXAMPLE/Search', 'example/app'],
    }),
    ['example/app', repository]
  );
  for (const value of [
    'org:example',
    ['example/*'],
    ['example/app is:open'],
    ['example/..'],
    [null],
  ]) {
    assert.throws(() =>
      githubReviewRepositories({ reviewRepositories: value })
    );
  }
});

test('paginates review-requested search and preserves the source repository', async () => {
  const urls = [];
  const other = { ...fixture.searchItem, id: 42002, number: 43 };
  const prs = await searchGithubPrs({
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return {
        ok: true,
        json: async () => ({
          total_count: 2,
          items: urls.length === 1 ? [fixture.searchItem] : [other],
        }),
      };
    },
    apiBase: 'https://api.github.com',
    headers: {},
    repository,
    qualifier: `is:open draft:false review-requested:${fixture.login}`,
    perPage: 1,
  });
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get('page'), '2');
  assert.equal(
    urls[0].searchParams.get('q'),
    `repo:${repository} is:pr is:open draft:false review-requested:${fixture.login}`
  );
  assert.equal(prs[0].repository, repository);
  assert.equal(prs[0].number, 42);
  assert.deepEqual(prs[0].assignees, []);
});

test('rejects partial, capped, failed and out-of-scope search instead of claiming completeness', async () => {
  for (const body of [
    { incomplete_results: true, items: [] },
    { total_count: 1001, items: [] },
    {
      items: [
        {
          ...fixture.searchItem,
          repository_url: 'https://api.github.com/repos/other/repo',
        },
      ],
    },
  ]) {
    await assert.rejects(
      searchGithubPrs({
        fetchImpl: async () => ({ ok: true, json: async () => body }),
        apiBase: '',
        headers: {},
        repository,
        qualifier: '',
        perPage: 100,
      })
    );
  }
  await assert.rejects(
    searchGithubPrs({
      fetchImpl: async () => ({ ok: false, status: 403 }),
      apiBase: '',
      headers: {},
      repository,
      qualifier: '',
      perPage: 100,
    })
  );
});

function harness(config = {}) {
  const links = new Map();
  const events = [];
  let sha = head.headSha;
  const args = {
    config,
    repositories: ['example/app', repository],
    loadPrs: async (repo) => [
      {
        ...pr,
        repository: repo,
        html_url: `https://github.com/${repo}/pull/42`,
      },
    ],
    loadHead: async (pr) => ({
      ...head,
      headSha:
        pr.repository === repository
          ? sha
          : 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
    findTracking: async (pr) => links.get(pr.html_url),
    pendingRetry: () => null,
    emit: async (event) => {
      events.push(event);
      if (event.type === 'pr')
        links.set(event.html_url, {
          issueId: `issue-${links.size}`,
          linked: true,
        });
    },
    persist: async () => {},
  };
  return {
    args,
    links,
    events,
    setSha: (value) => {
      sha = value;
    },
  };
}

test('search#42 and app#42 register once each with repo/head during seed, backfill and restart', async () => {
  for (const config of [
    {},
    { backfill: true },
    { cursorTs: '2026-10-28T00:00:00Z', seenIds: ['42001'] },
  ]) {
    const h = harness(config);
    const first = await reconcileGithubReviewPrs(h.args);
    assert.equal(first.processed, 2);
    assert.equal(first.missing.length, 0);
    assert.equal(first.open[1].headSha, head.headSha);
    assert.equal(h.events[1].repository, repository);
    // A fresh runtime uses serialized state and authoritative links, not seenIds.
    h.args.config = JSON.parse(JSON.stringify(config));
    await reconcileGithubReviewPrs(h.args);
    assert.deepEqual(
      h.events.map((e) => e.type),
      ['pr', 'pr']
    );
    assert.equal(Object.keys(config.reviewPrHeads).length, 2);
    h.setSha('cccccccccccccccccccccccccccccccccccccccc');
    await reconcileGithubReviewPrs(h.args);
    assert.equal(h.events.at(-1).type, 'pr_updated');
    assert.equal(h.events.at(-1).repository, repository);
    assert.equal(h.events.at(-1).previousHeadSha, head.headSha);
    assert.equal(h.links.size, 2);
  }
});

test('adopts manual recovery and exposes missing links, exhausted retries and no matching rule', async () => {
  const h = harness();
  h.links.set(pr.html_url, { issueId: 'TEST-1001', linked: true });
  let result = await reconcileGithubReviewPrs(h.args);
  assert.equal(result.open[1].issueId, 'TEST-1001');
  assert.equal(h.events.length, 1);
  h.links.set(pr.html_url, { issueId: 'TEST-1001', linked: false });
  result = await reconcileGithubReviewPrs(h.args);
  assert.equal(result.missing[0].status, 'link_pending');
  h.links.delete(pr.html_url);
  h.args.pendingRetry = () => 'retry_exhausted';
  result = await reconcileGithubReviewPrs(h.args);
  assert.equal(result.missing[0].status, 'retry_exhausted');
  h.args.pendingRetry = () => null;
  h.args.emit = async () => {};
  result = await reconcileGithubReviewPrs(h.args);
  assert.equal(result.missing[0].status, 'untracked');
});

test('marks failed repository reconciliation incomplete while continuing other selected repositories', async () => {
  const h = harness();
  h.args.loadPrs = async (repo) => {
    if (repo === 'example/app') throw new Error('GitHub 403');
    return [pr];
  };
  const result = await reconcileGithubReviewPrs(h.args);
  assert.equal(result.complete, false);
  assert.equal(result.open.length, 1);
  assert.deepEqual(result.errors, [
    { repository: 'example/app', error: 'GitHub 403' },
  ]);
  assert.equal(h.args.config.reviewPrReconciliation.complete, false);
});

test('review search falls back beyond the search ceiling or timeout and reads every open-PR page', async () => {
  for (const incomplete of [
    { total_count: 1001, items: [] },
    { incomplete_results: true, items: [] },
  ]) {
    const requests = [];
    const pull = {
      ...fixture.searchItem,
      ...fixture.details,
      base: { ...fixture.details.base, repo: { full_name: repository } },
    };
    const prs = await searchGithubPrs({
      fetchImpl: async (input) => {
        const url = new URL(input);
        requests.push(url);
        const body =
          url.pathname === '/search/issues'
            ? incomplete
            : url.searchParams.get('page') === '1'
              ? Array.from({ length: 100 }, (_, i) => ({
                  ...pull,
                  number: i + 1,
                  requested_reviewers: [],
                }))
              : [
                  pull,
                  { ...pull, number: 43, draft: true },
                  { ...pull, number: 44, requested_reviewers: [] },
                ];
        return { ok: true, json: async () => body };
      },
      apiBase: 'https://api.github.com',
      headers: {},
      repository,
      qualifier: `is:open draft:false review-requested:${fixture.login}`,
      reviewLogin: fixture.login,
      perPage: 100,
    });
    assert.equal(requests.length, 3);
    assert.equal(requests[2].pathname, `/repos/${repository}/pulls`);
    assert.equal(requests[2].searchParams.get('page'), '2');
    assert.deepEqual(
      prs.map((pr) => [pr.repository, pr.number]),
      [[repository, 42]]
    );
  }
});

test('an unreadable PR remains visibly missing without skipping later PRs in the repository', async () => {
  const h = harness();
  h.args.repositories = [repository];
  h.args.loadPrs = async () => [{ ...pr, number: 1 }, pr];
  h.args.loadHead = async (item) => {
    if (item.number === 1) throw new Error('Head API 503');
    return head;
  };
  const result = await reconcileGithubReviewPrs(h.args);
  assert.equal(result.complete, false);
  assert.equal(result.open.length, 2);
  assert.equal(result.missing.length, 1);
  assert.equal(result.open[0].headSha, null);
  assert.equal(result.open[1].status, 'tracked');
  assert.equal(h.events.length, 1);
});
