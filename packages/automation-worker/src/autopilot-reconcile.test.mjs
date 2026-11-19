import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  collectReconciliation,
  decisionReviews,
  reconcileAutopilot,
  validateReconciliationScope,
} from './autopilot-reconcile.mjs';
import { routeAutopilot } from './autopilot-router.mjs';

const projectId = '20000000-0000-4000-8000-000000000001';
const reviewTagId = '20000000-0000-4000-8000-000000000002';
const issueId = '20000000-0000-4000-8000-000000000003';
const boardNoteId = '20000000-0000-4000-8000-000000000004';
const scope = {
  projectId,
  reviewTagId,
  hosts: ['synthetic-machine'],
  tracked: [{ repository: 'synthetic/widgets', number: 7 }],
  registryHash: 'a'.repeat(64),
};
const head = 'b'.repeat(40);
function fixture() {
  const h = { reads: [], reviews: [], issueCount: 101 };
  h.collect = () =>
    collectReconciliation({
      scope: h.scope || scope,
      repositories: h.repositories || ['synthetic/widgets'],
      discover: async (repository) => {
        h.discoverCalls = (h.discoverCalls || 0) + 1;
        return h.discovered ?? [{ repository, number: 8 }];
      },
      github: async (path) => {
        h.reads.push(path);
        return path.includes('/reviews?')
          ? h.reviews
          : {
              id: h.identity?.(path) ?? Number(path.split('/').at(-1)),
              head: { sha: h.heads?.shift() || h.head || head },
              state: h.state || 'open',
              draft: false,
              updated_at: '2002-03-04T00:00:00Z',
            };
      },
      vibe: async (method, path, body, project) => {
        if (path.startsWith('/v1/tags/')) {
          if (project.projectId === h.missingTagFor) return {};
          return { id: project.reviewTagId, project_id: project.projectId };
        }
        if (path === `/v1/drawer_notes/${boardNoteId}`) {
          if (h.boardUnavailable) throw new Error('board read failed');
          return { id: boardNoteId, body: h.board };
        }
        if (path === '/v1/issues/search') {
          h.reads.push(body.offset);
          h.searchedProjects ||= [];
          h.searchedProjects.push(project.projectId);
          return {
            offset: body.offset,
            total_count: h.issueCount,
            issues: Array.from(
              { length: Math.min(100, h.issueCount - body.offset) },
              (_, index) => ({
                id: `30000000-0000-4000-8000-${String(body.offset + index).padStart(12, '0')}`,
                project_id: project.projectId,
                status_id: reviewTagId,
                updated_at: '2002-03-04T00:00:00Z',
              })
            ),
          };
        }
        return { pull_requests: [] };
      },
      host: async () => ({
        hostId: 'synthetic-machine',
        complete: true,
        workspaces: h.workspaces || [],
      }),
      now: () => h.now ?? Date.now(),
      terminalReviews: h.terminalReviews,
      signal: h.signal,
    });
  return h;
}

test('discovery covers all issue pages, including sessionless issues, and requested PRs', async () => {
  const h = fixture();
  const snapshot = await h.collect();
  assert.deepEqual(snapshot.counts, { issues: 101, prs: 2, hosts: 1 });
  assert.ok(h.reads.includes(100));
  assert.equal(h.discoverCalls, 1);
  assert.ok(
    h.reads.includes(
      '/repos/synthetic/widgets/pulls/8/reviews?per_page=100&page=1'
    )
  );
});

test('same-head review changes, dismissed reviews and timestamp conflicts remain visible', async () => {
  const review = {
    id: 11,
    state: 'APPROVED',
    commit_id: head,
    submitted_at: '2002-03-04T00:00:00Z',
    user: { login: 'synthetic-reviewer' },
  };
  assert.equal(decisionReviews([review], 'c'.repeat(40))[0].current, false);
  assert.equal(
    decisionReviews(
      [
        review,
        {
          ...review,
          id: 12,
          state: 'DISMISSED',
          submitted_at: '2002-03-05T00:00:00Z',
        },
      ],
      head
    )[0].state,
    'DISMISSED'
  );
  assert.equal(
    decisionReviews(
      [review, { ...review, id: 12, state: 'CHANGES_REQUESTED' }],
      head
    )[0].state,
    'UNDETERMINED'
  );
  const h = fixture();
  const before = await h.collect();
  h.reviews = [review];
  assert.notEqual((await h.collect()).fingerprint, before.fingerprint);
});

test('same-head discrepancies survive stale and failed publication until the board readback matches', async () => {
  const h = fixture();
  h.scope = { ...scope, boardNoteId, boardPrs: ['synthetic/widgets#7'] };
  const record = {};
  h.now = Date.parse('2002-03-06T00:00:00Z');
  const poll = (acknowledgedAt) =>
    reconcileAutopilot({
      scope: h.scope,
      record,
      collect: h.collect,
      persist: async () => {},
      now: () => h.now,
      acknowledgedAt,
    });
  await poll();
  h.now += 1000;
  const stamp = () => new Date(h.now).toISOString();
  assert.equal((await poll(stamp())).changed, false);
  h.now += 1000;
  h.reviews = [
    {
      id: 20,
      state: 'CHANGES_REQUESTED',
      commit_id: head,
      submitted_at: stamp(),
      user: { login: 'synthetic-reviewer' },
    },
  ];
  const {
    boardPending: [pending],
  } = await poll();
  assert.equal(pending.key, 'synthetic/widgets#7');

  const published =
    '| [PR 7](https://github.com/synthetic/widgets/pull/7) | Changes requested |';
  h.scope.boardResolutions = [
    {
      key: pending.key,
      fingerprint: pending.fingerprint,
      disposition: 'published',
      rowSha256: createHash('sha256').update(published).digest('hex'),
    },
  ];
  h.now += 1000;
  const acknowledgedAt = stamp();
  h.board = published.replace('Changes requested', 'Approved');
  assert.deepEqual((await poll(acknowledgedAt)).boardPending, [pending]);
  h.now += 1000;
  h.boardUnavailable = true;
  assert.equal((await poll(acknowledgedAt)).changed, true);
  h.boardUnavailable = false;
  h.board = `${published}\n${published}`;
  assert.equal((await poll(acknowledgedAt)).changed, true);
  h.board = published;
  const result = await poll(acknowledgedAt);
  assert.deepEqual(result.boardPending, []);
  assert.equal(result.changed, false);
});

test('a board hold requires reason, owner and future time and becomes due again', async () => {
  const h = fixture();
  h.scope = { ...scope, boardPrs: ['synthetic/widgets#7'] };
  h.now = Date.parse('2002-03-06T00:00:00Z');
  h.reviews = [
    {
      id: 21,
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2002-03-05T00:00:00Z',
      user: { login: 'synthetic-reviewer' },
    },
  ];
  const record = {};
  const poll = (acknowledgedAt) =>
    reconcileAutopilot({
      scope: h.scope,
      record,
      collect: h.collect,
      persist: async () => {},
      now: () => h.now,
      acknowledgedAt,
    });
  const {
    boardPending: [pending],
  } = await poll();
  h.now += 1000;
  const acknowledgedAt = new Date(h.now).toISOString();
  const hold = {
    key: pending.key,
    fingerprint: pending.fingerprint,
    disposition: 'hold',
    reason: 'Waiting for authoritative decision',
    owner: '',
    recheckAt: new Date(h.now + 2000).toISOString(),
  };
  h.scope.boardResolutions = [hold];
  assert.equal((await poll(acknowledgedAt)).changed, true);
  hold.owner = 'synthetic-operator';
  assert.equal((await poll(acknowledgedAt)).changed, false);
  h.now += 2000;
  assert.equal((await poll()).changed, true);
});

test('missing initial baseline and changed queues require an agent; only official acknowledgement permits quiet routing', async () => {
  const h = fixture();
  const record = {};
  let clock = Date.parse('2002-03-06T00:00:00Z');
  let writes = 0;
  const options = {
    scope,
    record,
    collect: h.collect,
    persist: async () => writes++,
    now: () => clock,
  };
  assert.equal((await reconcileAutopilot(options)).changed, true);
  clock += 1000;
  assert.equal(
    (
      await reconcileAutopilot({
        ...options,
        acknowledgedAt: '2002-03-06T00:00:00.500Z',
      })
    ).changed,
    false
  );
  const event = { kind: 'autopilot.reconcile' };
  const routed = await routeAutopilot({
    event,
    record,
    persist: options.persist,
    reconciliation: { scope, collect: h.collect, now: options.now },
  });
  assert.equal(routed.remaining.length, 0);
  assert.equal(routed.handled[0].source, 'rule');
  h.workspaces = [
    {
      id: issueId,
      sessions: [{ id: 'synthetic-session', queue_hash: 'changed' }],
    },
  ];
  assert.equal((await reconcileAutopilot(options)).changed, true);
  assert.equal(writes, 4);
});

test('incomplete reads and out-of-scope PRs cannot advance the baseline', async () => {
  const record = { baseline: { fingerprint: 'original' } };
  await assert.rejects(
    reconcileAutopilot({
      scope,
      record,
      collect: async () => {
        throw new Error('offline');
      },
      persist: async () => assert.fail('not persisted'),
    })
  );
  assert.equal(record.baseline.fingerprint, 'original');
  assert.throws(() =>
    validateReconciliationScope(
      { ...scope, tracked: [{ repository: 'other/widgets', number: 7 }] },
      ['synthetic/widgets']
    )
  );
});

test('overdue resumes keep the agent route even after acknowledgement of unchanged facts', async () => {
  const h = fixture();
  const dueAt = Date.parse('2002-03-07T00:00:00Z');
  h.now = dueAt - 1000;
  const resumes = [
    {
      id: '40000000-0000-4000-8000-000000000001',
      kind: 'scheduled',
      due_at: new Date(dueAt).toISOString(),
      content_hash: 'a'.repeat(64),
    },
  ];
  h.workspaces = [
    {
      id: issueId,
      sessions: [
        {
          id: '40000000-0000-4000-8000-000000000002',
          pending_resumes: 1,
          resumes,
        },
      ],
    },
  ];
  const record = {};
  const options = {
    record,
    collect: h.collect,
    persist: async () => {},
    now: () => h.now,
  };
  assert.equal((await reconcileAutopilot(options)).changed, true);
  h.now += 500;
  assert.equal(
    (
      await reconcileAutopilot({
        ...options,
        acknowledgedAt: new Date(h.now).toISOString(),
      })
    ).changed,
    false
  );
  h.now = dueAt;
  assert.equal((await reconcileAutopilot(options)).changed, true);
  h.now += 7 * 86400000;
  assert.equal(
    (
      await reconcileAutopilot({
        ...options,
        acknowledgedAt: new Date(h.now).toISOString(),
      })
    ).changed,
    true
  );
});

test('missing or malformed resume evidence cannot establish a quiet baseline', async () => {
  for (const resumes of [undefined, [], [{ due_at: 'invalid' }]]) {
    const h = fixture();
    h.workspaces = [
      { id: issueId, sessions: [{ pending_resumes: 1, resumes }] },
    ];
    await assert.rejects(h.collect(), /resume/);
  }
});

test('future or stale acknowledgements cannot accept a changed baseline', async () => {
  for (const acknowledgedAt of [
    '2002-03-08T00:00:00Z',
    '2002-03-05T00:00:00Z',
  ]) {
    const record = {
      pending: { at: '2002-03-06T00:00:00Z', fingerprint: 'snapshot' },
    };
    const result = await reconcileAutopilot({
      scope,
      record,
      collect: async () => ({ fingerprint: 'snapshot', counts: {} }),
      persist: async () => {},
      now: () => Date.parse('2002-03-06T00:01:00Z'),
      acknowledgedAt,
    });
    assert.equal(result.changed, true);
  }
});

test('a new non-decision review still changes the snapshot without being interpreted as approval', async () => {
  const h = fixture();
  const before = await h.collect();
  h.reviews = [
    {
      id: 23,
      state: 'COMMENTED',
      commit_id: head,
      submitted_at: '2002-03-04T00:00:00Z',
      user: { login: 'synthetic-reviewer' },
    },
  ];
  const after = await h.collect();
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.deepEqual(after.facts.heads[0].reviews, []);
});

test('a head change during reads and an invalid page count reject the whole snapshot', async () => {
  const changed = fixture();
  changed.heads = [head, 'c'.repeat(40)];
  await assert.rejects(changed.collect(), /PR changed/);
  const invalid = fixture();
  invalid.issueCount = -1;
  await assert.rejects(invalid.collect(), /incomplete issue discovery/);
});

test('only matching GitHub identities share one paginated review read', async () => {
  const h = fixture();
  h.issueCount = 0;
  h.repositories = ['synthetic/widgets', 'synthetic/archive'];
  h.discovered = [];
  h.scope = {
    ...scope,
    boardPrs: ['synthetic/widgets#7'],
    tracked: [...scope.tracked, { repository: 'synthetic/archive', number: 8 }],
  };
  h.identity = () => 50;
  const snapshots = await h.collect();
  assert.equal(snapshots.counts.prs, 1);
  assert.equal(snapshots.checkedTracked.length, 2);
  assert.equal(
    h.reads.filter(
      (path) => typeof path === 'string' && path.includes('/reviews?')
    ).length,
    1
  );
  assert.deepEqual(snapshots.facts.coverage.repositories, [
    'synthetic/archive',
    'synthetic/widgets',
  ]);
  h.reviews = [
    {
      id: 6,
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2002-03-04T01:00:00Z',
      user: { login: 'synthetic-reviewer' },
    },
  ];
  const { boardPending } = await reconcileAutopilot({
    scope: h.scope,
    collect: h.collect,
    record: {},
    persist: async () => {},
  });
  assert.deepEqual(
    boardPending.map((row) => row.key),
    ['synthetic/widgets#7']
  );
  h.identity = undefined;
  assert.equal((await h.collect()).counts.prs, 2);
  h.identity = () => 50;
  h.heads = [head, 'c'.repeat(40)];
  await assert.rejects(h.collect(), /alias resolution/);
});

test('each project tag must be verified before reporting complete scope', async () => {
  const h = fixture();
  h.issueCount = 0;
  const secondProject = '20000000-0000-4000-8000-000000000004';
  h.scope = {
    ...scope,
    projects: [
      { projectId, reviewTagId },
      { projectId: secondProject, reviewTagId },
    ],
  };
  const result = await h.collect();
  assert.deepEqual(h.searchedProjects, [projectId, secondProject]);
  assert.deepEqual(result.facts.coverage.projects, h.scope.projects);
  h.missingTagFor = secondProject;
  const record = {};
  await assert.rejects(
    reconcileAutopilot({
      record,
      collect: h.collect,
      persist: async () => assert.fail('partial proof persisted'),
    }),
    /review tag/
  );
  assert.deepEqual(record, {});
});

test('terminal review cache skips repeated audit, refreshes on expiry and detects a reopened PR', async () => {
  const h = fixture();
  h.issueCount = 0;
  h.discovered = [];
  h.state = 'closed';
  h.now = Date.parse('2002-03-04T00:00:00Z');
  const first = await h.collect();
  h.terminalReviews = first.terminalReviews;
  h.reads.length = 0;
  h.now += 60_000;
  const cached = await h.collect();
  assert.equal(cached.fingerprint, first.fingerprint);
  assert.equal(h.reads.filter((path) => typeof path === 'string').length, 1);
  h.now += 2 * 60 * 60 * 1000;
  const refreshed = await h.collect();
  assert.ok(
    refreshed.terminalReviews[7].auditedAt > first.terminalReviews[7].auditedAt
  );
  h.terminalReviews = refreshed.terminalReviews;
  h.state = 'open';
  h.reads.length = 0;
  const reopened = await h.collect();
  assert.notEqual(reopened.fingerprint, first.fingerprint);
  assert.ok(
    h.reads.includes(
      '/repos/synthetic/widgets/pulls/7/reviews?per_page=100&page=1'
    )
  );
  assert.deepEqual(reopened.terminalReviews, {});
});

test('an aborted collection cannot persist reconciliation state', async () => {
  const h = fixture();
  h.signal = AbortSignal.abort(new Error('synthetic timeout'));
  const record = { terminalReviews: { 7: { auditedAt: 0 } } };
  await assert.rejects(
    reconcileAutopilot({
      record,
      collect: h.collect,
      persist: async () => assert.fail('not persisted'),
    }),
    /synthetic timeout/
  );
  assert.deepEqual(record, { terminalReviews: { 7: { auditedAt: 0 } } });
});
