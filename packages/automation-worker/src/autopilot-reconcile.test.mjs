import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  GithubBudgetLow,
  checkGithubBudget,
  collectReconciliation,
  decisionReviews,
  reconcileAutopilot,
  validateReconciliationScope,
} from './autopilot-reconcile.mjs';

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
        assert.match(path, /\/reviews\?/);
        return h.reviews;
      },
      graphql: async (query) => {
        if (query.includes('ReconciliationOpenPullRequests')) {
          h.reads.push('open inventory');
          const open = h.openNumbers ?? (h.state === 'open' ? [7] : []);
          const cursor = query.match(/after: (null|"[^"]*")/)?.[1];
          const offset = Number(JSON.parse(cursor ?? 'null')) || 0;
          const end = Math.min(offset + 100, open.length);
          return {
            repository: {
              pullRequests: {
                totalCount: open.length,
                nodes: open.slice(offset, end).map((number) => ({ number })),
                pageInfo: {
                  hasNextPage: end < open.length,
                  endCursor: String(end),
                },
              },
            },
          };
        }
        const result = {};
        for (const [, key, owner, repository, rawNumber] of query.matchAll(
          /(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) { pullRequest\(number: (\d+)\)/g
        )) {
          const number = Number(rawNumber);
          const path = `/repos/${owner}/${repository}/pulls/${number}`;
          h.reads.push(path);
          if (h.missingNumber === number) continue;
          const state = h.prStates?.get(number) || h.state || 'open';
          result[key] = {
            pullRequest: {
              number,
              fullDatabaseId: String(h.identity?.(path) ?? number),
              headRefOid: h.heads?.shift() || h.head || head,
              state: state.toUpperCase(),
              isDraft: false,
              updatedAt: h.prUpdatedAt || '2002-03-04T00:00:00Z',
            },
          };
          if (h.invalidMetadata)
            Object.assign(result[key].pullRequest, h.invalidMetadata);
        }
        return result;
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
                updated_at: h.issueUpdatedAt || '2002-03-04T00:00:00Z',
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

test('incomplete PR metadata cannot produce a reconciliation checkpoint', async () => {
  for (const invalidMetadata of [
    { headRefOid: null },
    { updatedAt: null },
    { fullDatabaseId: '9007199254740993' },
  ]) {
    const h = fixture();
    h.invalidMetadata = invalidMetadata;
    await assert.rejects(h.collect(), /incomplete PR metadata batch/);
  }
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
    factsUnchanged,
  } = await poll();
  assert.equal(factsUnchanged, false);
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

test('same-head closure preserves a board hold without reading terminal reviews', async (t) => {
  for (const terminal of ['closed', 'merged']) {
    await t.test(terminal, async () => {
      const h = fixture();
      const pr = scope.tracked[0];
      const key = `${pr.repository}#${pr.number}`;
      h.scope = { ...scope, boardPrs: [key] };
      h.issueCount = 0;
      h.discovered = terminal === 'closed' ? [pr] : [];
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
          collect: (terminalReviews) => {
            h.terminalReviews = terminalReviews;
            return h.collect();
          },
          persist: async () => {},
          now: () => h.now,
          acknowledgedAt,
        });

      const [pending] = (await poll()).boardPending;
      h.now += 1000;
      const recheckAt = h.now + 2 * 60 * 60 * 1000;
      h.scope.boardResolutions = [
        {
          key,
          fingerprint: pending.fingerprint,
          disposition: 'hold',
          reason: 'Waiting for authoritative decision',
          owner: 'synthetic-operator',
          recheckAt: new Date(recheckAt).toISOString(),
        },
      ];
      assert.deepEqual(
        (await poll(new Date(h.now).toISOString())).boardPending,
        []
      );
      const held = record.boardPending[key];

      delete h.scope.boardResolutions;
      h.state = terminal;
      h.discovered = [];
      h.now += 1000;
      const closed = await poll();
      assert.equal(closed.changed, true);
      assert.equal(closed.githubReads.reviewPages, 0);
      assert.deepEqual(closed.boardPending, []);
      assert.deepEqual(record.boardPending[key], held);
      assert.equal(record.boardReviews[key].fingerprint, held.fingerprint);

      h.now += 1000;
      const cached = await poll();
      assert.equal(cached.githubReads.metadataBatches, 0);
      assert.equal(cached.githubReads.reviewPages, 0);
      assert.deepEqual(cached.boardPending, []);

      if (terminal === 'closed') {
        h.state = 'open';
        h.discovered = [pr];
        h.now += 1000;
        const reopened = await poll();
        assert.equal(reopened.githubReads.reviewPages, 1);
        assert.equal(reopened.boardPending[0].fingerprint, held.fingerprint);
        assert.equal(reopened.boardPending[0].hold, undefined);
      } else {
        h.now = recheckAt;
        assert.deepEqual((await poll()).boardPending, [held]);
      }
    });
  }
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
  assert.equal((await reconcileAutopilot(options)).changed, false);
  h.workspaces = [
    {
      id: issueId,
      sessions: [{ id: 'synthetic-session', queue_hash: 'changed' }],
    },
  ];
  assert.equal((await reconcileAutopilot(options)).changed, true);
  assert.equal(writes, 4);
});

test('a bound checkpoint advances only its stored observation when newer PR and queue facts arrive', async () => {
  const h = fixture();
  h.now = Date.parse('2002-03-06T00:00:00Z');
  const record = {};
  const session = '40000000-0000-4000-8000-000000000002';
  h.workspaces = [{ id: issueId, sessions: [{ id: session, queue_hash: 'empty' }] }];
  const poll = (acknowledgedAt, acknowledgedFingerprint) => reconcileAutopilot({
    scope: { ...scope, acknowledgedFingerprint }, collect: h.collect, record,
    acknowledgedAt, persist: async () => {}, now: () => h.now,
  });
  const first = await poll();
  h.now += 1000;
  assert.equal((await poll(new Date(h.now).toISOString())).changed, false);

  h.workspaces[0].sessions[0].queue_hash = 'one';
  h.now += 1000;
  const queued = await poll();
  assert.equal(queued.changes.baseFingerprint, first.fingerprint);
  assert.deepEqual(queued.changes.checks.map(({ kind }) => kind), ['session']);
  assert.equal(queued.changes.checks[0].after.queue_hash, 'one');

  h.workspaces[0].sessions[0].queue_hash = 'two';
  h.head = 'c'.repeat(40);
  h.now += 1000;
  // An acknowledgement for anything other than the last observed version cannot move the baseline.
  const copy = structuredClone(record);
  assert.equal((await poll(new Date(h.now).toISOString(), 'f'.repeat(64))).changed, true);
  assert.equal(record.baseline.fingerprint, first.fingerprint);
  Object.assign(record, copy);

  const changed = await poll(new Date(h.now).toISOString(), queued.fingerprint);
  assert.equal(changed.changed, true);
  assert.ok(changed.changes.checks.some(({ kind, after }) => kind === 'pr' && after.head === h.head));
  assert.equal(record.baseline.fingerprint, queued.fingerprint);
  assert.equal(changed.changes.baseFingerprint, queued.fingerprint);
  assert.equal(changed.changes.checks.find(({ kind }) => kind === 'session').before.queue_hash, 'one');
  h.now += 1000;
  assert.equal((await poll(new Date(h.now).toISOString(), changed.fingerprint)).changed, false);
  assert.equal(record.baseline.fingerprint, changed.fingerprint);
});

test('board membership changes retain proven source coverage and only genuine source expansion is full scope', async () => {
  const h = fixture();
  h.now = Date.parse('2002-03-06T00:00:00Z');
  const record = {};
  const poll = (input, acknowledgedAt) => {
    h.scope = input;
    return reconcileAutopilot({ scope: input, collect: h.collect, record,
      acknowledgedAt, persist: async () => {}, now: () => h.now });
  };
  const original = { ...scope, includeAuditSnapshot: true, boardPrs: ['synthetic/widgets#7'],
    tracked: [...scope.tracked, { repository: 'synthetic/widgets', number: 8 }] };
  const initial = await poll(original);
  assert.deepEqual(Object.keys(initial.auditSnapshot), ['prs', 'issues', 'hosts']);
  assert.ok(initial.auditSnapshot.prs.facts.some(({ key, head: value }) => key === 'synthetic/widgets#7' && value === head));
  h.now += 1000;
  await poll(original, new Date(h.now).toISOString());
  h.now += 1000;
  const input = { ...original, boardPrs: ['synthetic/widgets#8'] };
  const report = await poll(input);
  assert.equal(report.changes.scopeChanged, false);
  assert.deepEqual(report.changes.checks.map(({ kind, key, after }) => [kind, key, after]), [
    ['board', 'synthetic/widgets#7', null], ['board', 'synthetic/widgets#8', true],
  ]);
  assert.equal(report.changes.boardHeads['synthetic/widgets#8'], head);
  const expanded = await poll({ ...input, readRepositories: ['synthetic/other'] });
  assert.equal(expanded.changes.scopeChanged, true);
});

test('only registry changes indexed to a PR are eligible for a partial route', async () => {
  const h = fixture();
  h.now = Date.parse('2002-03-06T00:00:00Z');
  const record = {};
  const registryIndex = { unscoped: 'a'.repeat(64), byPr: { 'synthetic/widgets#7': 'b'.repeat(64) } };
  const poll = (input, acknowledgedAt) => {
    h.scope = input;
    return reconcileAutopilot({ scope: input, collect: h.collect, record,
      acknowledgedAt, persist: async () => {}, now: () => h.now });
  };
  const original = { ...scope, registryIndex };
  await poll(original);
  h.now += 1000;
  await poll(original, new Date(h.now).toISOString());
  const updated = { ...original, registryHash: 'd'.repeat(64), registryIndex: {
    ...registryIndex, byPr: { 'synthetic/widgets#7': 'e'.repeat(64) },
  } };
  const scoped = await poll(updated);
  assert.equal(scoped.changes.registryChanged, false);
  assert.deepEqual(scoped.changes.checks.map(({ kind, key }) => [kind, key]), [['registry', 'synthetic/widgets#7']]);
  assert.equal(scoped.changes.prFacts['synthetic/widgets#7'].head, head);
  const unscoped = await poll({ ...updated, registryIndex: { ...updated.registryIndex, unscoped: 'f'.repeat(64) } });
  assert.equal(unscoped.changes.registryChanged, true);
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

test('read-only repositories admit tracked and renamed PRs without widening discovery', async () => {
  const extra = { ...scope, readRepositories: ['synthetic/old-name', 'synthetic/other'] };
  // Without the extra list both refs are outside the allowlist.
  for (const repository of ['synthetic/old-name', 'synthetic/other'])
    assert.throws(() =>
      validateReconciliationScope(
        { ...scope, tracked: [...scope.tracked, { repository, number: 7 }] },
        ['synthetic/widgets']
      )
    );
  for (const readRepositories of ['synthetic/other', ['Not A Repo'], Array(17).fill('a/b')])
    assert.throws(() =>
      validateReconciliationScope({ ...scope, readRepositories }, ['synthetic/widgets'])
    );
  const h = fixture();
  h.scope = {
    ...extra,
    tracked: [
      ...scope.tracked,
      { repository: 'synthetic/old-name', number: 7 },
      { repository: 'synthetic/other', number: 9 },
    ],
  };
  // GitHub redirects the old name: both names read as one PR.
  h.identity = (path) => (path.includes('/pulls/7') ? 7 : Number(path.split('/').at(-1)));
  const snapshot = await h.collect();
  assert.equal(h.discoverCalls, 1, 'discovery stays on the allowlist');
  assert.deepEqual(snapshot.facts.coverage.repositories, ['synthetic/widgets']);
  assert.ok(h.reads.includes('/repos/synthetic/other/pulls/9'));
  assert.ok(h.reads.includes('/repos/synthetic/old-name/pulls/7'));
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

test('activity timestamps and unregistered workspaces leave the facts unchanged', async () => {
  const h = fixture();
  const review = '40000000-0000-4000-8000-000000000010';
  const other = '40000000-0000-4000-8000-000000000011';
  h.scope = { ...scope, watchSessions: [review.toUpperCase()] };
  h.now = Date.parse('2002-03-07T00:00:00Z');
  const workspace = (id, session, status, at, extra = {}) => ({
    id,
    archived: false,
    updated_at: at,
    pending_starts: 0,
    sessions: [
      {
        id: session,
        queue_hash: 'q',
        pending_resumes: 0,
        resumes: [],
        executions: [{ id: session, status, dropped: false, updated_at: at }],
        ...extra,
      },
    ],
  });
  const ids = (n) => `40000000-0000-4000-8000-00000000002${n}`;
  h.workspaces = [
    workspace(ids(0), review, 'completed', '2002-03-06T00:00:00Z'),
    workspace(ids(1), other, 'running', '2002-03-06T00:00:00Z'),
  ];
  const first = await h.collect();
  assert.deepEqual(
    first.facts.hosts[0].workspaces.map(({ id }) => id),
    [ids(0)]
  );
  h.workspaces = [
    workspace(ids(0), review, 'completed', '2002-03-06T09:00:00Z'),
    workspace(ids(1), other, 'completed', '2002-03-06T09:00:00Z'),
    workspace(ids(2), ids(3), 'running', '2002-03-06T09:00:00Z'),
  ];
  h.issueUpdatedAt = '2002-03-06T09:00:00Z';
  h.prUpdatedAt = '2002-03-06T09:00:00Z';
  const quiet = await h.collect();
  assert.equal(quiet.fingerprint, first.fingerprint);
  assert.equal(quiet.requiresAgent, false);
  // An unregistered workspace still raises due resumes.
  h.workspaces[1] = workspace(ids(1), other, 'completed', '2002-03-06T09:00:00Z', {
    pending_resumes: 1,
    resumes: [
      {
        id: ids(4),
        kind: 'scheduled',
        due_at: '2002-03-06T12:00:00Z',
        content_hash: 'a'.repeat(64),
      },
    ],
  });
  const due = await h.collect();
  assert.equal(due.fingerprint, first.fingerprint);
  assert.equal(due.requiresAgent, true);
  h.workspaces[1].sessions[0].pending_resumes = 0;
  h.workspaces[1].sessions[0].resumes = [];
  h.workspaces[0].sessions[0].executions[0].status = 'running';
  assert.notEqual((await h.collect()).fingerprint, first.fingerprint);
  h.scope = { ...scope, watchSessions: ['not-a-session'] };
  await assert.rejects(h.collect(), /invalid watched session scope/);
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

test('terminal snapshots do not reread closed PRs and detect a reopened PR beyond the first open page', async () => {
  const h = fixture();
  h.issueCount = 0;
  h.discovered = [];
  h.state = 'closed';
  const first = await h.collect();
  h.terminalReviews = first.terminalReviews;
  h.reads.length = 0;
  const cached = await h.collect();
  assert.equal(cached.fingerprint, first.fingerprint);
  assert.deepEqual(cached.githubReads, {
    metadataBatches: 0,
    openListPages: 1,
    reviewPages: 0,
    reusedTerminal: 1,
  });
  // Old snapshots include updated_at and do not record merged status.
  const { merged, ...legacy } = first.terminalReviews[7];
  assert.equal(merged, false);
  h.terminalReviews = {
    7: { ...legacy, facts: { ...legacy.facts, updated_at: 'old' } },
  };
  assert.equal((await h.collect()).fingerprint, first.fingerprint);
  h.state = 'open';
  h.openNumbers = [...Array.from({ length: 100 }, (_, i) => 100 + i), 7];
  const reopened = await h.collect();
  assert.notEqual(reopened.fingerprint, first.fingerprint);
  assert.equal(reopened.githubReads.openListPages, 2);
  assert.equal(reopened.githubReads.reviewPages, 1);
  assert.deepEqual(reopened.terminalReviews, {});
});

test('418 tracked PRs use bounded metadata batches and skip merged and closed history on the next run', async () => {
  const h = fixture();
  h.issueCount = 0;
  h.discovered = [];
  h.state = 'merged';
  h.prStates = new Map([
    [6, 'closed'],
    [7, 'open'],
  ]);
  h.scope = {
    ...scope,
    tracked: Array.from({ length: 418 }, (_, i) => ({
      repository: 'synthetic/widgets',
      number: i + 1,
    })),
  };
  const first = await h.collect();
  assert.deepEqual(first.githubReads, {
    metadataBatches: 12,
    openListPages: 0,
    reviewPages: 1,
    reusedTerminal: 0,
  });
  h.terminalReviews = first.terminalReviews;
  h.reads.length = 0;
  const second = await h.collect();
  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(second.githubReads, {
    metadataBatches: 2,
    openListPages: 1,
    reviewPages: 1,
    reusedTerminal: 417,
  });
  assert.ok(
    h.reads
      .filter((path) => typeof path === 'string' && path.startsWith('/repos/'))
      .every((path) => path.includes('/pulls/7'))
  );
  h.prStates.set(7, 'merged');
  const merged = await h.collect();
  assert.notEqual(merged.fingerprint, second.fingerprint);
  assert.equal(merged.githubReads.metadataBatches, 1);
  assert.equal(merged.githubReads.reviewPages, 0);
  h.terminalReviews = merged.terminalReviews;
  assert.equal((await h.collect()).githubReads.metadataBatches, 0);
});

test('an incomplete metadata batch cannot commit a reconciliation result', async () => {
  const h = fixture();
  h.missingNumber = 7;
  const record = {};
  await assert.rejects(
    reconcileAutopilot({
      record,
      collect: h.collect,
      persist: async () => assert.fail('partial metadata persisted'),
    }),
    /incomplete PR metadata batch/
  );
  assert.deepEqual(record, {});
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

test('a same-head re-request (Awaiting review from you) changes facts and makes the board row due', async () => {
  const h = fixture();
  h.scope = { ...scope, boardPrs: ['synthetic/widgets#7'] };
  h.discovered = [];
  const record = {};
  h.now = Date.parse('2002-03-06T00:00:00Z');
  h.reviews = [
    {
      id: 30,
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2002-03-05T00:00:00Z',
      user: { login: 'synthetic-reviewer' },
    },
  ];
  const poll = () =>
    reconcileAutopilot({
      scope: h.scope,
      record,
      collect: h.collect,
      persist: async () => {},
      now: () => h.now,
    });
  const first = await poll();
  assert.equal(first.boardPending.length, 1); // first sighting of a decision
  const settled = { ...record.boardReviews };
  record.boardPending = {};
  h.now += 1000;
  assert.deepEqual((await poll()).boardPending, []);
  assert.deepEqual(record.boardReviews, settled);
  h.discovered = [{ repository: 'synthetic/widgets', number: 7 }];
  h.now += 1000;
  const requested = await poll();
  assert.notEqual(requested.fingerprint, first.fingerprint);
  assert.equal(requested.boardPending[0].key, 'synthetic/widgets#7');
  assert.equal(requested.boardPending[0].head, head);
});

test('reconciliation never spends the last reserved GitHub calls', () => {
  assert.throws(() => checkGithubBudget(1499, 1500), GithubBudgetLow);
  assert.throws(
    () => checkGithubBudget(1499, 1500, 101),
    (error) => error instanceof GithubBudgetLow && error.retryAt === 101
  );
  assert.throws(
    () => checkGithubBudget(1499, 1500, 0),
    (error) => error instanceof GithubBudgetLow && error.retryAt === undefined
  );
  assert.doesNotThrow(() => checkGithubBudget(1500, 1500));
  // An unknown budget leaves the decision to the next response header.
  assert.doesNotThrow(() => checkGithubBudget(undefined, 1500));
  assert.doesNotThrow(() => checkGithubBudget(Number.NaN, 1500));
});

test('board work for a PR that left the board does not block a quiet baseline', async () => {
  const h = fixture();
  h.issueCount = 0;
  h.discovered = [];
  const stale = 'synthetic/widgets#99';
  const record = {
    boardPending: {
      [stale]: { key: stale, head, fingerprint: 'f', detectedAt: '2002-03-05T00:00:00Z' },
    },
  };
  let clock = Date.parse('2002-03-06T00:00:00Z');
  const options = {
    scope: { ...scope, boardPrs: ['synthetic/widgets#7'] },
    record,
    collect: h.collect,
    persist: async () => {},
    now: () => clock,
  };
  const first = await reconcileAutopilot(options);
  assert.deepEqual(first.boardPending, []);
  assert.equal(Object.hasOwn(record.boardPending, stale), false);
  clock += 1000;
  assert.equal(
    (await reconcileAutopilot({ ...options, acknowledgedAt: new Date(clock - 500).toISOString() })).changed,
    false
  );
});

test('board work is isolated only if the other reconciliation facts are unchanged', async () => {
  const pending = {
    key: 'synthetic/widgets#7',
    fingerprint: 'a'.repeat(64),
  };
  const record = {
    baseline: { fingerprint: 'b'.repeat(64) },
    boardPending: { [pending.key]: pending },
  };
  const run = (requiresAgent) =>
    reconcileAutopilot({
      scope: { boardPrs: [pending.key] },
      record,
      collect: async () => ({ fingerprint: 'b'.repeat(64), requiresAgent }),
      persist: async () => {},
    });
  const result = await run(false);
  assert.deepEqual(result.boardPending, [pending]);
  assert.equal(result.changed, true);
  assert.equal(result.factsUnchanged, true);
  assert.equal((await run(true)).factsUnchanged, false);
});
