import assert from 'node:assert/strict';
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
      scope,
      repositories: ['synthetic/widgets'],
      discover: async () => [{ repository: 'synthetic/widgets', number: 8 }],
      github: async (path) => {
        h.reads.push(path);
        return path.includes('/reviews?')
          ? h.reviews
          : {
              head: { sha: h.heads?.shift() || h.head || head },
              state: 'open',
              draft: false,
              updated_at: '2002-03-04T00:00:00Z',
            };
      },
      vibe: async (method, path, body) => {
        if (path === '/v1/issues/search') {
          h.reads.push(body.offset);
          return {
            offset: body.offset,
            total_count: h.issueCount,
            issues: Array.from(
              { length: Math.min(100, h.issueCount - body.offset) },
              (_, index) => ({
                id: `30000000-0000-4000-8000-${String(body.offset + index).padStart(12, '0')}`,
                project_id: projectId,
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
    });
  return h;
}

test('discovery covers all issue pages, including sessionless issues, and requested PRs', async () => {
  const h = fixture();
  const snapshot = await h.collect();
  assert.deepEqual(snapshot.counts, { issues: 101, prs: 2, hosts: 1 });
  assert.ok(h.reads.includes(100));
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
  const changed = fixture(); changed.heads = [head, 'c'.repeat(40)];
  await assert.rejects(changed.collect(), /PR changed/);
  const invalid = fixture(); invalid.issueCount = -1;
  await assert.rejects(invalid.collect(), /incomplete issue discovery/);
});
