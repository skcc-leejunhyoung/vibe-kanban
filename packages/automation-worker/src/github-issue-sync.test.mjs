import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backfillLegacyGithubIssueLinks,
  ensureGithubIssueForLink,
  githubIssueMapBackfillEntries,
  githubIssueMarker,
  runSingleFlight,
  retryPendingGithubIssueLinkOperations,
  shouldSyncGithubProjectStatus,
  withGithubIssueMarker,
  withoutGithubIssueMarker,
} from './github-issue-sync.mjs';

test('reuses the persisted GitHub issue when link persistence is retried', async () => {
  const operation = {
    createdAt: '2026-07-31T00:00:00.000Z',
    githubIssue: null,
  };
  let creates = 0;
  let persists = 0;
  const dependencies = {
    mode: 'create',
    issueId: 'issue-1',
    title: 'Title',
    description: 'Body',
    operation,
    findCreatedIssue: async () => null,
    createIssue: async ({ title, body }) => {
      creates += 1;
      return { number: 7, title, body };
    },
    fetchExistingIssue: async () => {
      throw new Error('not used');
    },
    persistOperation: async () => {
      persists += 1;
    },
  };

  const first = await ensureGithubIssueForLink(dependencies);
  // Simulate the later Vibe link write failing, then retry the whole operation.
  const second = await ensureGithubIssueForLink(dependencies);

  assert.equal(creates, 1);
  assert.equal(persists, 1);
  assert.equal(second, first);
  assert.match(first.body, /<!-- vibe-kanban-issue:issue-1 -->/);
});

test('recovers a created issue by marker after a worker crash before persistence', async () => {
  const recovered = { number: 8, body: githubIssueMarker('issue-2') };
  let creates = 0;
  const issue = await ensureGithubIssueForLink({
    mode: 'create',
    issueId: 'issue-2',
    title: 'Title',
    description: null,
    operation: {
      createdAt: '2026-07-31T00:00:00.000Z',
      githubIssue: null,
    },
    findCreatedIssue: async (marker) =>
      marker === githubIssueMarker('issue-2') ? recovered : null,
    createIssue: async () => {
      creates += 1;
      return {};
    },
    fetchExistingIssue: async () => null,
    persistOperation: async () => {},
  });

  assert.equal(issue, recovered);
  assert.equal(creates, 0);
});

test('single-flight collapses concurrent create-and-link requests', async () => {
  const inFlight = new Map();
  let calls = 0;
  const task = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 'linked';
  };

  const results = await Promise.all([
    runSingleFlight(inFlight, 'rule:issue', task),
    runSingleFlight(inFlight, 'rule:issue', task),
  ]);

  assert.deepEqual(results, ['linked', 'linked']);
  assert.equal(calls, 1);
  assert.equal(inFlight.size, 0);
});

test('strips only the hidden Vibe marker from synchronized descriptions', () => {
  const marked = withGithubIssueMarker('Visible body', 'issue-3');
  assert.equal(withoutGithubIssueMarker(marked), 'Visible body');
  assert.equal(withoutGithubIssueMarker(githubIssueMarker('issue-3')), null);
});

test('honors the project-status synchronization switch', () => {
  assert.equal(
    shouldSyncGithubProjectStatus({ fields: { status: false } }),
    false
  );
  assert.equal(
    shouldSyncGithubProjectStatus({ fields: { status: true } }),
    true
  );
  assert.equal(shouldSyncGithubProjectStatus({}), true);
});

test('selects only unlinked legacy issueMap entries for the configured repository', () => {
  assert.deepEqual(
    githubIssueMapBackfillEntries({
      issueMap: {
        'Org/Repo#1': 'vibe-1',
        'org/repo#2': 'vibe-2',
        'other/repo#3': 'vibe-3',
        invalid: 'vibe-4',
      },
      repository: 'org/repo',
      linkedIssueIds: ['vibe-1'],
      skippedSourceKeys: [],
    }),
    [{ sourceKey: 'org/repo#2', issueId: 'vibe-2', number: 2 }]
  );
});

test('poller backfill links issues, skips PRs, and leaves transient failures retryable', async () => {
  const entries = [
    { sourceKey: 'org/repo#1', issueId: 'vibe-1', number: 1 },
    { sourceKey: 'org/repo#2', issueId: 'vibe-2', number: 2 },
    { sourceKey: 'org/repo#3', issueId: 'vibe-3', number: 3 },
  ];
  const issues = new Map(
    entries.map((entry) => [
      entry.issueId,
      {
        id: entry.issueId,
        title: entry.sourceKey,
        description: null,
        status_id: 'todo',
        updated_at: '2026-07-31T00:00:00Z',
      },
    ])
  );
  const skipped = [];
  const failed = [];
  const result = await backfillLegacyGithubIssueLinks({
    entries,
    issues,
    repository: 'org/repo',
    ruleId: 'sync',
    linkIssue: async ({ issueId }) => {
      if (issueId === 'vibe-2') {
        throw new Error('pull request URLs cannot be linked as GitHub issues');
      }
      if (issueId === 'vibe-3') throw new Error('temporary network failure');
    },
    onPullRequest: async (entry) => skipped.push(entry.sourceKey),
    onFailure: async (entry) => failed.push(entry.sourceKey),
  });

  assert.deepEqual(result, { linked: 1, skipped: 1, failed: 1 });
  assert.deepEqual(skipped, ['org/repo#2']);
  assert.deepEqual(failed, ['org/repo#3']);
});

test('poller retries only pending operations for its GitHub connector', async () => {
  const retried = [];
  const failures = [];
  const recovered = await retryPendingGithubIssueLinkOperations({
    operations: [
      { githubConnectorId: 'github-1', input: { issueId: 'vibe-1' } },
      { githubConnectorId: 'github-2', input: { issueId: 'vibe-2' } },
      { githubConnectorId: 'github-1', input: { issueId: 'vibe-3' } },
    ],
    connectorId: 'github-1',
    linkIssue: async (input) => {
      retried.push(input.issueId);
      if (input.issueId === 'vibe-3') throw new Error('still unavailable');
    },
    onFailure: async (operation) => failures.push(operation.input.issueId),
  });

  assert.equal(recovered, 1);
  assert.deepEqual(retried, ['vibe-1', 'vibe-3']);
  assert.deepEqual(failures, ['vibe-3']);
});
