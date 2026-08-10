import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertGithubIssueProject,
  backfillLegacyGithubIssueLinks,
  commentMarkerId,
  decideCommentSync,
  decideGithubParentSync,
  decideGithubMilestoneSync,
  decideGithubProjectStatusSync,
  ensureGithubIssueForLink,
  selectGithubImportCandidates,
  githubIssueMapBackfillEntries,
  githubIssueMarker,
  githubIssueSyncVibeConnectorId,
  githubMilestoneMetaDiffers,
  markGithubIssueSeen,
  normalizeOptionalTimestamp,
  planCommentSync,
  runSingleFlight,
  retryPendingGithubIssueLinkOperations,
  selectGithubPollCandidates,
  shouldRunGithubIssueSyncRule,
  shouldSyncGithubProjectStatus,
  withCommentMarker,
  withGithubIssueMarker,
  withoutCommentMarker,
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
      {
        name: 'M1',
        target_date: '2026-08-31T00:00:00.000Z',
        completed_at: null,
      },
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

const LINK_RETRY_POLICY = {
  now: 1_000_000,
  maxAttempts: 3,
  retryDelay: (attempts) => attempts * 1000,
};

test('poller retries only pending operations for its GitHub connector', async () => {
  const retried = [];
  const failures = [];
  const { remaining, recovered, changed } =
    await retryPendingGithubIssueLinkOperations({
      ...LINK_RETRY_POLICY,
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
  assert.equal(changed, true);
  assert.deepEqual(retried, ['vibe-1', 'vibe-3']);
  assert.deepEqual(failures, ['vibe-3']);
  // 성공한 op 는 빠지고, 다른 커넥터의 op 와 재시도 대기 op 만 남는다.
  assert.deepEqual(
    remaining.map((op) => op.input.issueId),
    ['vibe-2', 'vibe-3']
  );
  const retryOp = remaining.find((op) => op.input.issueId === 'vibe-3');
  assert.equal(retryOp.attempts, 1);
  assert.equal(retryOp.nextAttemptAt, LINK_RETRY_POLICY.now + 1000);
});

test('pending github link waiting on backoff is not attempted again', async () => {
  const retried = [];
  const { remaining, recovered, changed } =
    await retryPendingGithubIssueLinkOperations({
      ...LINK_RETRY_POLICY,
      operations: [
        {
          githubConnectorId: 'github-1',
          input: { issueId: 'vibe-1' },
          attempts: 1,
          nextAttemptAt: LINK_RETRY_POLICY.now + 5000,
        },
      ],
      connectorId: 'github-1',
      linkIssue: async (input) => retried.push(input.issueId),
      onFailure: async () => {},
    });

  assert.deepEqual(retried, []);
  assert.equal(recovered, 0);
  assert.equal(changed, false);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].attempts, 1);
});

test('pending github link is carried forward without spending an attempt while its target is disabled', async () => {
  // 규칙/커넥터가 잠시 꺼져 있으면(예: 사용자가 토글 off) 시도를 소진하지 말고
  // 그대로 보관해야 한다 — 그러지 않으면 몇 분 만에 5회 소진되어 유효한 링크가
  // 영구 폐기되며, 이 큐가 막으려던 고아화가 재발한다.
  const retried = [];
  const { remaining, recovered, changed } =
    await retryPendingGithubIssueLinkOperations({
      ...LINK_RETRY_POLICY,
      operations: [
        {
          githubConnectorId: 'github-1',
          input: { issueId: 'vibe-1' },
          attempts: 2,
        },
      ],
      connectorId: 'github-1',
      isAvailable: () => false,
      linkIssue: async (input) => retried.push(input.issueId),
      onFailure: async () => {},
      onExhausted: async () => {},
    });

  assert.deepEqual(retried, []);
  assert.equal(recovered, 0);
  assert.equal(changed, false);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].attempts, 2);
});

test('permanently failing github link is dropped once attempts are exhausted', async () => {
  // 삭제된 Vibe 이슈를 가리키는 op 는 절대 성공하지 못한다. 무한 보관하면 폴링마다
  // 404 를 때리고 state.json 만 부풀린다.
  const exhausted = [];
  const failures = [];
  const { remaining, changed } = await retryPendingGithubIssueLinkOperations({
    ...LINK_RETRY_POLICY,
    operations: [
      {
        githubConnectorId: 'github-1',
        input: { issueId: 'vibe-gone' },
        attempts: 2,
      },
    ],
    connectorId: 'github-1',
    linkIssue: async () => {
      throw new Error('Vibe GET /v1/issues/vibe-gone failed: 404');
    },
    onFailure: async (op) => failures.push(op.input.issueId),
    onExhausted: async (op) => exhausted.push(op.input.issueId),
  });

  assert.deepEqual(remaining, []);
  assert.deepEqual(exhausted, ['vibe-gone']);
  assert.deepEqual(failures, []);
  assert.equal(changed, true);
});

const STATUS_MAPPINGS = [
  { vibeStatusId: 'vibe-todo', githubOptionId: 'gh-todo' },
  { vibeStatusId: 'vibe-done', githubOptionId: 'gh-done' },
];

test('first status sync adopts the GitHub value instead of pushing', () => {
  // 임포트 직후 링크는 synced_vibe_status_id 가 비어 있다. 이때 Vibe 기본 컬럼을
  // 밀어넣으면 GitHub 프로젝트 보드가 통째로 덮인다(#5603 사고).
  assert.deepEqual(
    decideGithubProjectStatusSync({
      statusMappings: STATUS_MAPPINGS,
      vibeStatusId: 'vibe-todo',
      syncedVibeStatusId: null,
      githubOptionId: 'gh-done',
      syncedGithubOptionId: null,
    }),
    { action: 'adopt', vibeStatusId: 'vibe-done', githubOptionId: 'gh-done' }
  );
});

test('first status sync never overwrites an unmapped GitHub value', () => {
  assert.deepEqual(
    decideGithubProjectStatusSync({
      statusMappings: STATUS_MAPPINGS,
      vibeStatusId: 'vibe-todo',
      syncedVibeStatusId: null,
      githubOptionId: 'gh-unmapped',
      syncedGithubOptionId: null,
    }),
    { action: 'none', vibeStatusId: 'vibe-todo', githubOptionId: 'gh-unmapped' }
  );
});

test('first status sync pushes only when the project item has no status', () => {
  assert.deepEqual(
    decideGithubProjectStatusSync({
      statusMappings: STATUS_MAPPINGS,
      vibeStatusId: 'vibe-todo',
      syncedVibeStatusId: null,
      githubOptionId: null,
      syncedGithubOptionId: null,
    }),
    { action: 'push', vibeStatusId: 'vibe-todo', githubOptionId: 'gh-todo' }
  );
});

test('established links keep bidirectional status precedence', () => {
  assert.deepEqual(
    decideGithubProjectStatusSync({
      statusMappings: STATUS_MAPPINGS,
      vibeStatusId: 'vibe-done',
      syncedVibeStatusId: 'vibe-todo',
      githubOptionId: 'gh-todo',
      syncedGithubOptionId: 'gh-todo',
    }),
    { action: 'push', vibeStatusId: 'vibe-done', githubOptionId: 'gh-done' }
  );
  assert.deepEqual(
    decideGithubProjectStatusSync({
      statusMappings: STATUS_MAPPINGS,
      vibeStatusId: 'vibe-todo',
      syncedVibeStatusId: 'vibe-todo',
      githubOptionId: 'gh-done',
      syncedGithubOptionId: 'gh-todo',
    }),
    { action: 'adopt', vibeStatusId: 'vibe-done', githubOptionId: 'gh-done' }
  );
  assert.deepEqual(
    decideGithubProjectStatusSync({
      statusMappings: STATUS_MAPPINGS,
      vibeStatusId: 'vibe-todo',
      syncedVibeStatusId: 'vibe-todo',
      githubOptionId: 'gh-todo',
      syncedGithubOptionId: 'gh-todo',
    }),
    { action: 'none', vibeStatusId: 'vibe-todo', githubOptionId: 'gh-todo' }
  );
});

test('seeding poll imports nothing and seeds every source', () => {
  const candidates = [{ number: 1 }, { number: 2, __projectItem: true }];
  assert.deepEqual(
    selectGithubImportCandidates({ candidates, seeding: true }),
    {
      importCandidates: [],
      seedOnly: candidates,
    }
  );
  assert.deepEqual(
    selectGithubImportCandidates({ candidates, seeding: false }),
    { importCandidates: candidates, seedOnly: [] }
  );
});

test('comment marker round-trips and survives edited bodies', () => {
  const marked = withCommentMarker('hello', 'vc-1');
  assert.equal(marked, 'hello\n\n<!-- vibe-kanban-comment:vc-1 -->');
  assert.equal(withoutCommentMarker(marked), 'hello');
  assert.equal(commentMarkerId(marked), 'vc-1');
  // Idempotent: never stacks a second marker.
  assert.equal(withCommentMarker(marked, 'vc-1'), marked);
  // A GitHub-edited body (text changed, marker kept) still strips clean.
  assert.equal(
    withoutCommentMarker('edited text\n\n<!-- vibe-kanban-comment:vc-1 -->'),
    'edited text'
  );
  assert.equal(commentMarkerId('no marker here'), null);
});

test('decideCommentSync: equal is a no-op, else newest updated_at wins', () => {
  assert.equal(
    decideCommentSync({ githubMessage: 'x', vibeMessage: 'x' }).direction,
    'none'
  );
  assert.equal(
    decideCommentSync({
      githubMessage: 'gh',
      vibeMessage: 'vb',
      githubUpdatedAt: '2026-08-10T02:00:00Z',
      vibeUpdatedAt: '2026-08-10T01:00:00Z',
    }).direction,
    'to_vibe'
  );
  assert.equal(
    decideCommentSync({
      githubMessage: 'gh',
      vibeMessage: 'vb',
      githubUpdatedAt: '2026-08-10T01:00:00Z',
      vibeUpdatedAt: '2026-08-10T02:00:00Z',
    }).direction,
    'to_github'
  );
});

test('planCommentSync seeds silently when no cutoff is set', () => {
  const plan = planCommentSync({
    githubComments: [
      {
        id: 1,
        body: 'old gh',
        created_at: '2026-08-01T00:00:00Z',
        user: { login: 'octo' },
      },
    ],
    vibeComments: [
      { id: 'v1', message: 'old vibe', created_at: '2026-08-01T00:00:00Z' },
    ],
    cutoff: null,
  });
  assert.deepEqual(plan, { imports: [], pushes: [], edits: [], repairs: [] });
});

test('planCommentSync only crosses comments created after the cutoff', () => {
  const cutoff = '2026-08-10T00:00:00Z';
  const plan = planCommentSync({
    githubComments: [
      // pre-cutoff GitHub comment: never imported
      {
        id: 1,
        body: 'history',
        created_at: '2026-08-09T00:00:00Z',
        user: { login: 'octo' },
      },
      // post-cutoff new GitHub comment: imported
      {
        id: 2,
        body: 'fresh gh',
        created_at: '2026-08-10T01:00:00Z',
        user: { login: 'octo' },
      },
    ],
    vibeComments: [
      // pre-cutoff native vibe comment: never pushed (no retroactive publish)
      {
        id: 'v-old',
        message: 'internal history',
        created_at: '2026-08-09T00:00:00Z',
        github_comment_id: null,
        github_author_login: null,
      },
      // post-cutoff native vibe comment: pushed
      {
        id: 'v-new',
        message: 'reply',
        created_at: '2026-08-10T02:00:00Z',
        github_comment_id: null,
        github_author_login: null,
      },
    ],
    cutoff,
  });
  assert.deepEqual(
    plan.imports.map((c) => c.id),
    [2]
  );
  assert.deepEqual(
    plan.pushes.map((c) => c.id),
    ['v-new']
  );
  assert.deepEqual(plan.edits, []);
  assert.deepEqual(plan.repairs, []);
});

test('planCommentSync never echoes: mapped and github-origin comments are not re-sent', () => {
  const cutoff = '2026-08-10T00:00:00Z';
  const plan = planCommentSync({
    githubComments: [
      {
        id: 10,
        body: 'mirrored',
        created_at: '2026-08-10T01:00:00Z',
        updated_at: '2026-08-10T01:00:00Z',
        user: { login: 'octo' },
      },
    ],
    vibeComments: [
      // vibe comment already mapped to gh#10 with identical text → no-op
      {
        id: 'v10',
        message: 'mirrored',
        created_at: '2026-08-10T01:00:00Z',
        updated_at: '2026-08-10T01:00:00Z',
        github_comment_id: '10',
        github_author_login: null,
      },
      // a comment imported FROM github → must never be pushed back
      {
        id: 'v11',
        message: 'from gh',
        created_at: '2026-08-10T03:00:00Z',
        github_comment_id: '999',
        github_author_login: 'octo',
      },
    ],
    cutoff,
  });
  assert.deepEqual(plan, { imports: [], pushes: [], edits: [], repairs: [] });
});

test('planCommentSync repairs a lost mapping via the marker instead of duplicating', () => {
  const cutoff = '2026-08-10T00:00:00Z';
  const plan = planCommentSync({
    githubComments: [
      {
        id: 20,
        body: 'pushed\n\n<!-- vibe-kanban-comment:v20 -->',
        created_at: '2026-08-10T01:00:00Z',
        user: { login: 'octo' },
      },
    ],
    vibeComments: [
      // native comment we pushed, but the id-store never landed
      {
        id: 'v20',
        message: 'pushed',
        created_at: '2026-08-10T01:00:00Z',
        github_comment_id: null,
        github_author_login: null,
      },
    ],
    cutoff,
  });
  assert.deepEqual(plan.repairs, [
    { vibeCommentId: 'v20', githubCommentId: '20' },
  ]);
  // Not imported (would duplicate) and not pushed again (repaired this round).
  assert.deepEqual(plan.imports, []);
  assert.deepEqual(plan.pushes, []);
});

test('planCommentSync edit reconcile picks the newer side on a mapped pair', () => {
  const cutoff = '2026-08-10T00:00:00Z';
  const plan = planCommentSync({
    githubComments: [
      {
        id: 30,
        body: 'gh edit\n\n<!-- vibe-kanban-comment:v30 -->',
        created_at: '2026-08-10T01:00:00Z',
        updated_at: '2026-08-10T05:00:00Z',
        user: { login: 'octo' },
      },
    ],
    vibeComments: [
      {
        id: 'v30',
        message: 'vibe old',
        created_at: '2026-08-10T01:00:00Z',
        updated_at: '2026-08-10T02:00:00Z',
        github_comment_id: '30',
        github_author_login: null,
      },
    ],
    cutoff,
  });
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].direction, 'to_vibe');
  assert.equal(plan.edits[0].message, 'gh edit');
});

test('planCommentSync never references a comment outside the two issue pools it was given', () => {
  const cutoff = '2026-08-10T00:00:00Z';
  const githubComments = [
    // new → import
    {
      id: 'g-new',
      body: 'new gh',
      created_at: '2026-08-10T01:00:00Z',
      user: { login: 'a' },
    },
    // mapped, github edited later → edit to_vibe
    {
      id: 'g-mapped',
      body: 'x\n\n<!-- vibe-kanban-comment:v-mapped -->',
      created_at: '2026-08-10T01:00:00Z',
      updated_at: '2026-08-10T09:00:00Z',
      user: { login: 'a' },
    },
    // carries our marker but unmapped → repair
    {
      id: 'g-repair',
      body: 'r\n\n<!-- vibe-kanban-comment:v-repair -->',
      created_at: '2026-08-10T01:00:00Z',
      user: { login: 'a' },
    },
    // pre-cutoff → ignored
    {
      id: 'g-old',
      body: 'old',
      created_at: '2026-08-09T00:00:00Z',
      user: { login: 'a' },
    },
  ];
  const vibeComments = [
    {
      id: 'v-mapped',
      message: 'y',
      created_at: '2026-08-10T01:00:00Z',
      updated_at: '2026-08-10T02:00:00Z',
      github_comment_id: 'g-mapped',
      github_author_login: null,
    },
    {
      id: 'v-repair',
      message: 'r',
      created_at: '2026-08-10T01:00:00Z',
      github_comment_id: null,
      github_author_login: null,
    },
    {
      id: 'v-push',
      message: 'p',
      created_at: '2026-08-10T03:00:00Z',
      github_comment_id: null,
      github_author_login: null,
    },
    // imported earlier; its github twin was deleted (not in this fetch) →
    // must produce nothing (never pushed back, never edited against a stranger).
    {
      id: 'v-imported',
      message: 'from gh',
      created_at: '2026-08-10T03:00:00Z',
      github_comment_id: 'g-deleted-elsewhere',
      github_author_login: 'a',
    },
  ];
  const plan = planCommentSync({ githubComments, vibeComments, cutoff });

  // Invariant: every target the plan emits is a member of the pools it was
  // handed — it can never fabricate an id belonging to some other issue.
  const ghIds = new Set(githubComments.map((c) => String(c.id)));
  const vbIds = new Set(vibeComments.map((c) => String(c.id)));
  for (const gc of plan.imports) assert.ok(ghIds.has(String(gc.id)));
  for (const vc of plan.pushes) assert.ok(vbIds.has(String(vc.id)));
  for (const e of plan.edits) {
    assert.ok(vbIds.has(String(e.vibe.id)));
    if (e.direction === 'to_github') assert.ok(ghIds.has(String(e.github.id)));
  }
  for (const r of plan.repairs) {
    assert.ok(vbIds.has(String(r.vibeCommentId)));
    assert.ok(ghIds.has(String(r.githubCommentId)));
  }

  // And the concrete routing for this mixed batch:
  assert.deepEqual(
    plan.imports.map((c) => c.id),
    ['g-new']
  );
  assert.deepEqual(
    plan.pushes.map((c) => c.id),
    ['v-push']
  );
  assert.deepEqual(plan.repairs, [
    { vibeCommentId: 'v-repair', githubCommentId: 'g-repair' },
  ]);
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].vibe.id, 'v-mapped');
  assert.equal(plan.edits[0].direction, 'to_vibe');
});
