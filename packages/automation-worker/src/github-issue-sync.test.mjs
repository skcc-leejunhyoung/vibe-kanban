import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertGithubIssueProject,
  backfillLegacyGithubIssueLinks,
  decideGithubParentSync,
  decideGithubMilestoneSync,
  ensureGithubIssueForLink,
  githubIssueMapBackfillEntries,
  githubIssueMarker,
  githubIssueSyncVibeConnectorId,
  githubMilestoneMetaDiffers,
  markGithubIssueSeen,
  normalizeOptionalTimestamp,
  runSingleFlight,
  retryPendingGithubIssueLinkOperations,
  selectGithubPollCandidates,
  shouldRunGithubIssueSyncRule,
  shouldSyncGithubProjectStatus,
  withGithubIssueMarker,
  withoutGithubIssueMarker,
} from './github-issue-sync.mjs';

test('normalizes Electric timestamps before sending them to the Vibe API', () => {
  assert.equal(
    normalizeOptionalTimestamp('2026-08-03 06:02:25.367666+00'),
    '2026-08-03T06:02:25.367Z'
  );
  assert.equal(
    normalizeOptionalTimestamp('', '2026-08-03T06:03:32Z'),
    '2026-08-03T06:03:32.000Z'
  );
  assert.equal(normalizeOptionalTimestamp('', 'invalid'), null);
});

test('synchronizes parent creation, moves, removal, and concurrent changes', () => {
  assert.deepEqual(
    decideGithubParentSync({
      baselineParentIssueId: null,
      vibeParentIssueId: 'vibe-parent',
      githubParentIssueId: null,
      vibeUpdatedAt: '2026-08-03T01:00:00Z',
      githubUpdatedAt: '2026-08-03T00:00:00Z',
    }),
    { direction: 'to_github', parentIssueId: 'vibe-parent' }
  );
  assert.deepEqual(
    decideGithubParentSync({
      baselineParentIssueId: 'old-parent',
      vibeParentIssueId: 'old-parent',
      githubParentIssueId: 'github-parent',
      vibeUpdatedAt: '2026-08-03T01:00:00Z',
      githubUpdatedAt: '2026-08-03T02:00:00Z',
    }),
    { direction: 'to_vibe', parentIssueId: 'github-parent' }
  );
  assert.deepEqual(
    decideGithubParentSync({
      baselineParentIssueId: 'old-parent',
      vibeParentIssueId: null,
      githubParentIssueId: 'old-parent',
      vibeUpdatedAt: '2026-08-03T02:00:00Z',
      githubUpdatedAt: '2026-08-03T01:00:00Z',
    }),
    { direction: 'to_github', parentIssueId: null }
  );
  assert.deepEqual(
    decideGithubParentSync({
      baselineParentIssueId: 'old-parent',
      vibeParentIssueId: 'vibe-parent',
      githubParentIssueId: 'github-parent',
      vibeUpdatedAt: '2026-08-03T02:00:00Z',
      githubUpdatedAt: '2026-08-03T03:00:00Z',
    }),
    { direction: 'to_vibe', parentIssueId: 'github-parent' }
  );
  assert.deepEqual(
    decideGithubParentSync({
      baselineParentIssueId: null,
      vibeParentIssueId: 'same-parent',
      githubParentIssueId: 'same-parent',
    }),
    { direction: 'none', parentIssueId: 'same-parent' }
  );
});

test('reconciles milestone assignment in both directions with latest-write conflicts', () => {
  assert.deepEqual(
    decideGithubMilestoneSync({
      baselineMilestoneId: null,
      baselineGithubNumber: null,
      vibeMilestoneId: 'vibe-1',
      githubMilestoneNumber: null,
    }),
    { direction: 'to_github' }
  );
  assert.deepEqual(
    decideGithubMilestoneSync({
      baselineMilestoneId: 'vibe-1',
      baselineGithubNumber: 1,
      vibeMilestoneId: 'vibe-1',
      githubMilestoneNumber: 2,
    }),
    { direction: 'to_vibe' }
  );
  assert.deepEqual(
    decideGithubMilestoneSync({
      baselineMilestoneId: 'vibe-1',
      baselineGithubNumber: 1,
      vibeMilestoneId: null,
      githubMilestoneNumber: 2,
      vibeUpdatedAt: '2026-08-04T03:00:00Z',
      githubUpdatedAt: '2026-08-04T02:00:00Z',
    }),
    { direction: 'to_github' }
  );
  assert.deepEqual(
    decideGithubMilestoneSync({
      baselineMilestoneId: null,
      baselineGithubNumber: null,
      vibeMilestoneId: 'vibe-1',
      githubMilestoneNumber: 7,
      assignmentsMatch: true,
    }),
    { direction: 'none' }
  );
});

test('dedups the same issue arriving as a Project item and a REST result across polls', () => {
  // A Project V2 item exposes issue.id as the GraphQL node id; the REST
  // assigned-issues poll exposes issue.id as the numeric REST id. Both agree on
  // issue.number. The project item is prepended before REST results.
  const projectItem = {
    id: 'PVTI_node_7',
    number: 7,
    updated_at: '2026-08-04T00:00:00Z',
    __projectItem: true,
  };
  const restIssue = {
    id: 12345678,
    number: 7,
    updated_at: '2026-08-04T00:00:00Z',
  };

  // Poll 1: fresh sets. Only one candidate survives; the REST twin is folded in.
  const seen = new Set();
  const seenNumbers = new Set();
  const first = selectGithubPollCandidates({
    items: [projectItem, restIssue],
    seen,
    seenNumbers,
  });
  assert.deepEqual(
    first.candidates.map((issue) => issue.id),
    ['PVTI_node_7']
  );
  assert.ok(seenNumbers.has('7'));
  // Import marks it seen in both sets (mirrors the poll's import loop).
  markGithubIssueSeen(projectItem, seen, seenNumbers);

  // Poll 2 after the issue is edited: the REST twin (numeric id, never in
  // `seen`) must NOT re-import as a duplicate — `seenNumbers` catches it.
  const editedRest = { ...restIssue, updated_at: '2026-08-05T00:00:00Z' };
  const second = selectGithubPollCandidates({
    items: [projectItem, editedRest],
    seen,
    seenNumbers,
  });
  assert.deepEqual(second.candidates, []);
  assert.equal(second.latest, '2026-08-05T00:00:00Z');
});

test('never dedups review PRs by number (cross-repo numbers collide)', () => {
  // A repo-local issue #7 was already seen by number.
  const seen = new Set();
  const seenNumbers = new Set(['7']);
  // A review-requested PR #7 from a different repo shares the number but is a
  // distinct entity; it must stay a candidate.
  const reviewPr = {
    id: 'PR_other_repo',
    number: 7,
    pull_request: {},
    __reviewPr: true,
    updated_at: '2026-08-04T00:00:00Z',
  };
  const { candidates } = selectGithubPollCandidates({
    items: [reviewPr],
    seen,
    seenNumbers,
  });
  assert.deepEqual(
    candidates.map((issue) => issue.id),
    ['PR_other_repo']
  );
  // Assigned-query PRs are still dropped unless includePullRequests is set.
  const dropped = selectGithubPollCandidates({
    items: [{ id: 9, number: 8, pull_request: {} }],
    seen: new Set(),
    seenNumbers: new Set(),
  });
  assert.deepEqual(dropped.candidates, []);
});

test('keeps same-numbered review PRs from different repos in one batch', () => {
  // Two review-requested PRs share number #7 but live in different repos, so
  // both surface in a single poll with distinct ids. Within-batch dedup must key
  // review PRs by id, not number, or one would be silently dropped.
  const { candidates } = selectGithubPollCandidates({
    items: [
      {
        id: 'PR_repo_a',
        number: 7,
        pull_request: {},
        __reviewPr: true,
        updated_at: '2026-08-04T00:00:00Z',
      },
      {
        id: 'PR_repo_b',
        number: 7,
        pull_request: {},
        __reviewPr: true,
        updated_at: '2026-08-04T00:00:00Z',
      },
    ],
    seen: new Set(),
    seenNumbers: new Set(),
  });
  assert.deepEqual(
    candidates.map((issue) => issue.id),
    ['PR_repo_a', 'PR_repo_b']
  );
});

test('treats same-day milestone dates as equal to avoid reconcile write churn', () => {
  // GitHub returns due_on at a fixed time-of-day; Vibe stores 00:00Z. Same day
  // must NOT count as a difference, or every reconcile would re-PATCH both sides.
  assert.equal(
    githubMilestoneMetaDiffers(
      { name: 'M1', target_date: '2026-08-31T00:00:00.000Z', completed_at: null },
      { title: 'M1', due_on: '2026-08-31T08:00:00Z', state: 'open' }
    ),
    false
  );
  // Real differences are still detected.
  assert.equal(
    githubMilestoneMetaDiffers(
      { name: 'M1', target_date: '2026-08-31T00:00:00Z', completed_at: null },
      { title: 'M1', due_on: '2026-09-01T08:00:00Z', state: 'open' }
    ),
    true
  );
  assert.equal(
    githubMilestoneMetaDiffers(
      { name: 'M1', target_date: null, completed_at: null },
      { title: 'renamed', due_on: null, state: 'open' }
    ),
    true
  );
  assert.equal(
    githubMilestoneMetaDiffers(
      { name: 'M1', target_date: null, completed_at: '2026-08-31T00:00:00Z' },
      { title: 'M1', due_on: null, state: 'open' }
    ),
    true
  );
});

test('rejects linking an issue outside the rule configured project', () => {
  assert.doesNotThrow(() =>
    assertGithubIssueProject({ project_id: 'project-1' }, 'project-1')
  );
  assert.throws(
    () => assertGithubIssueProject({ project_id: 'project-2' }, 'project-1'),
    /does not belong to the configured project/
  );
});

test('scopes GitHub sync rules to their configured source and target connectors', () => {
  const rule = {
    kind: 'github_issue_sync',
    config: {
      githubConnectorId: 'github-2',
      vibeConnectorId: 'vibe-2',
    },
  };
  assert.equal(
    shouldRunGithubIssueSyncRule(rule, { connectorId: 'github-1' }),
    false
  );
  assert.equal(
    shouldRunGithubIssueSyncRule(rule, { connectorId: 'github-2' }),
    true
  );
  assert.equal(githubIssueSyncVibeConnectorId(rule, 'vibe-default'), 'vibe-2');
  assert.equal(
    githubIssueSyncVibeConnectorId({ kind: 'script' }, 'vibe-default'),
    'vibe-default'
  );
});

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
