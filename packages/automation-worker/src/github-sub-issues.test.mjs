import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canConfirmGithubParentRemoval,
  fetchGithubIssueParent,
  githubIssueLinkKey,
  githubIssueRepositoriesShareOwner,
  updateGithubIssueParent,
} from './github-sub-issues.mjs';

function response(status, body = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

test('reads a GitHub parent and treats 404 as no parent', async () => {
  const calls = [];
  const parent = await fetchGithubIssueParent({
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(200, JSON.stringify({ number: 7 }));
    },
    apiBase: 'https://api.github.test',
    link: { repository: 'Org/Repo', number: 8 },
    headers: { authorization: 'hidden' },
  });
  assert.deepEqual(parent, { number: 7 });
  assert.equal(
    calls[0][0],
    'https://api.github.test/repos/Org/Repo/issues/8/parent'
  );

  assert.equal(
    await fetchGithubIssueParent({
      fetchImpl: async () => response(404),
      apiBase: 'https://api.github.test',
      link: { repository: 'Org/Repo', number: 8 },
      headers: {},
    }),
    null
  );
});

test('confirms a missing cross-repository parent only when it remains readable', async () => {
  const childLink = { repository: 'Org/Child', number: 8 };
  const previousParentLink = { repository: 'Org/Parent', number: 7 };
  const calls = [];
  assert.equal(
    await canConfirmGithubParentRemoval({
      fetchImpl: async (...args) => {
        calls.push(args);
        return response(200);
      },
      apiBase: 'https://api.github.test',
      childLink,
      previousParentLink,
      headers: { authorization: 'hidden' },
    }),
    true
  );
  assert.equal(
    calls[0][0],
    'https://api.github.test/repos/Org/Parent/issues/7'
  );

  assert.equal(
    await canConfirmGithubParentRemoval({
      fetchImpl: async () => response(404),
      apiBase: 'https://api.github.test',
      childLink,
      previousParentLink,
      headers: {},
    }),
    false
  );
  assert.equal(
    await canConfirmGithubParentRemoval({
      fetchImpl: async () => {
        throw new Error('same-repository removal should not fetch again');
      },
      apiBase: 'https://api.github.test',
      childLink,
      previousParentLink: { repository: 'org/child', number: 7 },
      headers: {},
    }),
    true
  );
  assert.equal(
    await canConfirmGithubParentRemoval({
      fetchImpl: async () => response(200),
      apiBase: 'https://api.github.test',
      childLink,
      previousParentLink: null,
      headers: {},
    }),
    false
  );
});

test('adds or replaces a parent with the official sub_issues endpoint', async () => {
  const calls = [];
  await updateGithubIssueParent({
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(201);
    },
    apiBase: 'https://api.github.test',
    child: { id: 123 },
    currentParent: null,
    nextParentLink: { repository: 'Org/Repo', number: 7 },
    headers: {},
  });

  assert.equal(
    calls[0][0],
    'https://api.github.test/repos/Org/Repo/issues/7/sub_issues'
  );
  assert.deepEqual(calls[0][1], {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ sub_issue_id: 123, replace_parent: true }),
  });
});

test('recognizes the GitHub same-owner constraint for sub-issues', () => {
  assert.equal(
    githubIssueRepositoriesShareOwner('Org/Parent', 'org/child'),
    true
  );
  assert.equal(
    githubIssueRepositoriesShareOwner('Other/Parent', 'org/child'),
    false
  );
  assert.equal(githubIssueRepositoriesShareOwner('', 'org/child'), false);
});

test('removes the current parent with the official sub_issue endpoint', async () => {
  const calls = [];
  await updateGithubIssueParent({
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(200);
    },
    apiBase: 'https://api.github.test',
    child: { id: 123 },
    currentParent: {
      number: 7,
      repository_url: 'https://api.github.test/repos/Org/Repo',
    },
    nextParentLink: null,
    headers: {},
  });

  assert.equal(
    calls[0][0],
    'https://api.github.test/repos/Org/Repo/issues/7/sub_issue'
  );
  assert.equal(calls[0][1].method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[0][1].body), { sub_issue_id: 123 });
  assert.equal(
    githubIssueLinkKey({ repository: 'ORG/REPO', number: 7 }),
    'org/repo#7'
  );
});
