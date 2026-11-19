import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { decideGithubParentSync } from './github-issue-sync.mjs';
import * as subIssues from './github-sub-issues.mjs';

const {
  GITHUB_ISSUE_NODES_QUERY,
  githubIssueLinkRelocation,
  githubIssueParentKey,
  githubRepositoryMoves,
  parseGithubIssueNodes,
} = subIssues;
const API = 'https://api.github.test';
const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');

function functionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing production function ${name}`);
  return source.slice(match.index, source.indexOf('\n}\n', match.index) + 2);
}

function node(id, repository, number, parent = null) {
  return {
    id,
    number,
    url: `https://github.test/${repository}/issues/${number}`,
    repository: { nameWithOwner: repository },
    parent,
  };
}

const nodesOf = (ids, list) =>
  parseGithubIssueNodes(ids, { data: { nodes: list } }, API);

function harness(overrides = {}) {
  const logs = [];
  const calls = [];
  const context = {
    ...subIssues,
    decideGithubParentSync,
    logs,
    calls,
    log: async (level, message, details) =>
      logs.push({ level, message, details }),
    errorMessage: (error) => error.message,
    githubHeaders: () => ({ authorization: 'synthetic' }),
    vibeApi: async (...args) => {
      calls.push(['vibe', ...args]);
      return { data: { ...args[3] } };
    },
    fetch: async (url, options = {}) => {
      calls.push(['fetch', url, options.method || 'GET']);
      return { status: 404, ok: false, text: async () => '' };
    },
    githubGraphql: async (connector, query, variables, options) => {
      calls.push(['graphql', variables.ids, options]);
      return {
        data: { nodes: variables.ids.map((id) => node(id, 'example/app', 1)) },
      };
    },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      'loadGithubIssueNodes',
      'relocateGithubIssueLinks',
      'relocateGithubMilestones',
      'reconcileGithubIssueParent',
      'reconcileGithubIssueRules',
    ]
      .map(functionSource)
      .join('\n'),
    context,
  );
  return context;
}

test('reads current address and parent per resolved node, aligned by ID', () => {
  const nodes = nodesOf(
    ['A', 'B', 'C', 'D', 'E'],
    [
      node('A', 'example/moved', 7, {
        number: 3,
        repository: { nameWithOwner: 'example/moved' },
      }),
      node('B', 'example/moved', 8),
      null, // unresolvable ID
      node('X', 'example/moved', 9), // misaligned answer
      node('E', 'example/moved', 10, { number: 'bad' }),
    ],
  );
  assert.deepEqual([...nodes.keys()], ['A', 'B', 'E']);
  assert.deepEqual(nodes.get('A'), {
    repository: 'example/moved',
    number: 7,
    url: 'https://github.test/example/moved/issues/7',
    parent: { number: 3, repository_url: `${API}/repos/example/moved` },
  });
  assert.equal(nodes.get('B').parent, null);
  // A malformed parent is unknown, not "no parent": REST decides.
  assert.equal(nodes.get('E').parent, undefined);
  assert.equal(
    githubIssueParentKey(nodes.get('A').parent),
    githubIssueParentKey({
      number: 3,
      repository_url: 'https://api.github.com/repos/Example/Moved',
    }),
  );
  assert.equal(githubIssueParentKey(null), null);
  assert.match(GITHUB_ISSUE_NODES_QUERY, /nodes\(ids: \$ids\)/);
});

test('drops nodes with errors and distrusts a batch with unplaced errors', () => {
  const data = {
    nodes: [node('A', 'example/app', 1), node('B', 'example/app', 2)],
  };
  const perNode = parseGithubIssueNodes(
    ['A', 'B'],
    { data, errors: [{ type: 'FORBIDDEN', path: ['nodes', 1, 'parent'] }] },
    API,
  );
  assert.deepEqual([...perNode.keys()], ['A']);
  const unplaced = parseGithubIssueNodes(
    ['A', 'B'],
    { data, errors: [{ message: 'something went wrong' }] },
    API,
  );
  assert.equal(unplaced.size, 0);
});

test('relocates only links GitHub serves from another address', () => {
  const link = { repository: 'example/old', number: 7, url: 'old' };
  const moved = {
    repository: 'example/new',
    number: 7,
    url: 'https://github.test/example/new/issues/7',
  };
  assert.deepEqual(githubIssueLinkRelocation(link, moved), moved);
  assert.deepEqual(githubIssueLinkRelocation(link, { ...moved, number: 70 }), {
    ...moved,
    number: 70,
  });
  assert.equal(
    githubIssueLinkRelocation(link, { ...moved, repository: 'Example/OLD' }),
    null,
  );
  assert.equal(githubIssueLinkRelocation(link, undefined), null);
});

test('derives a repository move only when all its issues moved together', () => {
  const links = [
    { github_node_id: 'A', repository: 'Example/Old', number: 1 },
    { github_node_id: 'B', repository: 'example/old', number: 2 },
    { github_node_id: 'C', repository: 'example/split', number: 3 },
    { github_node_id: 'D', repository: 'example/split', number: 4 },
    { github_node_id: 'E', repository: 'example/issue-moved', number: 5 },
    // One issue transferred out under the same number; its siblings stayed.
    { github_node_id: 'F', repository: 'example/stays', number: 6 },
    { github_node_id: 'G', repository: 'example/stays', number: 7 },
  ];
  const nodes = nodesOf(
    ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    [
      node('A', 'example/new', 1),
      node('B', 'example/new', 2),
      node('C', 'example/one', 3),
      node('D', 'example/two', 4),
      node('E', 'example/elsewhere', 50),
      node('F', 'example/target', 6),
      node('G', 'example/stays', 7),
    ],
  );
  assert.deepEqual(
    [...githubRepositoryMoves(links, nodes)],
    [['example/old', 'example/new']],
  );
});

test('loads nodes in batches of 100 and survives a failed batch', async () => {
  let batches = 0;
  const h = harness({
    githubGraphql: async (connector, query, { ids }, options) => {
      batches += 1;
      assert.equal(options.fullResponse, true);
      if (batches === 2) throw new Error('synthetic outage');
      return { data: { nodes: ids.map((id) => node(id, 'example/app', 1)) } };
    },
  });
  const links = Array.from({ length: 150 }, (_, i) => ({
    github_node_id: `N${i}`,
  }));
  links.push({ github_node_id: 'N0' }, { github_node_id: null });
  const nodes = await h.loadGithubIssueNodes(
    { id: 'github', config: { apiBase: API } },
    links,
  );
  assert.equal(batches, 2);
  assert.equal(nodes.size, 100);
  assert.equal(h.logs[0].message, 'github issue node lookup failed');
  assert.equal(h.logs[0].details.count, 50);
});

test('moves links to the current address unless another link or the connector holds it', async () => {
  const h = harness();
  const link = (id, repository, number) => ({
    id: `L${id}`,
    issue_id: `i${id}`,
    github_node_id: id,
    repository,
    number,
    url: `u${id}`,
  });
  const moved = link('A', 'example/old', 1);
  const held = link('B', 'example/old', 2);
  const holder = link('C', 'example/new', 2);
  const own = link('D', 'example/own-old', 4);
  const nodes = nodesOf(
    ['A', 'B', 'C', 'D'],
    [
      node('A', 'example/new', 1),
      node('B', 'example/new', 2),
      node('C', 'example/new', 2),
      node('D', 'example/own-new', 4),
    ],
  );
  await h.relocateGithubIssueLinks(
    { id: 'vibe' },
    [moved, held, holder, own],
    nodes,
    'Example/Own-Old',
  );

  assert.deepEqual(
    h.calls.map((call) => call.slice(0, 4)),
    [['vibe', { id: 'vibe' }, 'PATCH', '/v1/github_issue_links/LA']],
  );
  assert.deepEqual(h.calls[0][4], {
    repository: 'example/new',
    number: 1,
    url: 'https://github.test/example/new/issues/1',
  });
  assert.equal(moved.repository, 'example/new');
  assert.equal(held.repository, 'example/old');
  assert.equal(own.repository, 'example/own-old');
  assert.deepEqual(
    h.logs.map((entry) => entry.message),
    [
      'github issue link relocated',
      'github issue link relocation skipped',
      'github connector repository has moved',
    ],
  );
  assert.equal(h.logs[0].details.persisted, true);
  assert.equal(h.logs[2].details.links, 1);
});

test('a failed relocation leaves the link untouched; an ignored one still applies this round', async () => {
  const link = () => ({
    id: 'L1',
    issue_id: 'i1',
    github_node_id: 'A',
    repository: 'example/old',
    number: 1,
    url: 'u1',
  });
  const nodes = nodesOf(['A'], [node('A', 'example/new', 1)]);

  const failing = harness({
    vibeApi: async () => {
      throw Object.assign(new Error('conflict'), { status: 409 });
    },
  });
  const kept = link();
  await failing.relocateGithubIssueLinks({}, [kept], nodes, 'example/app');
  assert.equal(kept.repository, 'example/old');
  assert.equal(failing.logs[0].message, 'github issue link relocation failed');

  const legacy = harness({ vibeApi: async () => ({ data: link() }) });
  const applied = link();
  await legacy.relocateGithubIssueLinks({}, [applied], nodes, 'example/app');
  assert.equal(applied.repository, 'example/new');
  assert.equal(legacy.logs[0].details.persisted, false);
});

test('milestones follow their moved repository', async () => {
  const h = harness();
  const milestones = [
    { id: 'm1', source_repository: 'Example/Old', source_number: 1 },
    { id: 'm2', source_repository: 'example/other', source_number: 1 },
    { id: 'm3', source_repository: null, source_number: null },
  ];
  await h.relocateGithubMilestones(
    {},
    milestones,
    new Map([['example/old', 'example/new']]),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.calls.map((call) => [call[3], call[4]]))),
    [['/v1/project_milestones/m1', { source_repository: 'example/new' }]],
  );
  assert.equal(milestones[0].source_repository, 'example/new');
  assert.equal(milestones[1].source_repository, 'example/other');
});

test('a milestone whose new-name copy already exists is left in place', async () => {
  const h = harness();
  const milestones = [
    { id: 'old', source_repository: 'example/old', source_number: 4 },
    { id: 'copy', source_repository: 'Example/New', source_number: 4 },
  ];
  await h.relocateGithubMilestones(
    {},
    milestones,
    new Map([['example/old', 'example/new']]),
  );
  assert.equal(h.calls.length, 0);
  assert.equal(milestones[0].source_repository, 'example/old');
  assert.equal(h.logs[0].message, 'github milestone relocation skipped');
});

test('a sync round relocates first and hands each link its node and milestone address', async () => {
  const links = [
    {
      id: 'L1',
      issue_id: 'i1',
      github_node_id: 'A',
      repository: 'example/old',
      number: 1,
      url: 'u1',
    },
    {
      id: 'L2',
      issue_id: 'i2',
      github_node_id: 'B',
      repository: 'example/old',
      number: 2,
      url: 'u2',
    },
  ];
  const milestones = [{ id: 'm1', source_repository: 'example/old' }];
  const seen = [];
  const vibe = { id: 'vibe', enabled: true, config: { projectId: 'p' } };
  const h = harness({
    state: {
      rules: [
        {
          enabled: true,
          kind: 'github_issue_sync',
          config: {
            githubConnectorId: 'github',
            vibeConnectorId: 'vibe',
            includeIssuesFromOtherRepositories: true,
          },
        },
      ],
    },
    findConnector: () => vibe,
    retryPendingGithubIssueLinks: async () => 0,
    backfillGithubIssueMapLinks: async () => 0,
    shouldReconcileGithubIssueLink: () => true,
    githubCommentSyncKey: (github, v, link) => link.id,
    githubCommentSyncCache: new Map(),
    githubGraphql: async () => ({
      data: {
        nodes: [
          node('A', 'example/new', 1, {
            number: 2,
            repository: { nameWithOwner: 'example/new' },
          }),
          node('B', 'example/new', 2),
        ],
      },
    }),
    vibeApi: async (connector, method, url, payload) => {
      if (method === 'GET' && url.startsWith('/v1/github_issue_links'))
        return { github_issue_links: links };
      if (method === 'GET' && url.startsWith('/v1/issues'))
        return { issues: [{ id: 'i1' }, { id: 'i2' }] };
      if (method === 'GET' && url.startsWith('/v1/project_milestones'))
        return milestones;
      if (method === 'GET') return [];
      // L2's PATCH conflicts, so it keeps the old address this round.
      if (url === '/v1/github_issue_links/L2')
        throw Object.assign(new Error('conflict'), { status: 409 });
      return { data: { ...payload } };
    },
    reconcileGithubIssueLink: async (rule, github, v, link, issue, options) => {
      seen.push({
        link: `${link.repository}#${link.number}`,
        parent: options.githubNode?.parent?.number ?? null,
        milestoneRepository: options.milestoneRepository,
        relocatedKey: options.linksByExternalKey.has('example/new#1'),
      });
    },
  });
  const result = await h.reconcileGithubIssueRules({
    id: 'github',
    config: { owner: 'example', repo: 'app', apiBase: API },
  });

  assert.equal(result.synced, 2);
  assert.equal(milestones[0].source_repository, 'example/new');
  assert.deepEqual(seen, [
    {
      link: 'example/new#1',
      parent: 2,
      milestoneRepository: 'example/new',
      relocatedKey: true,
    },
    {
      link: 'example/old#2',
      parent: null,
      milestoneRepository: 'example/new',
      relocatedKey: true,
    },
  ]);
});

test('a prefetched parent replaces the REST read when nothing is written to GitHub', async () => {
  const h = harness();
  const result = await h.reconcileGithubIssueParent(
    parentInput({
      prefetchedParent: {
        number: 3,
        repository_url: `${API}/repos/example/app`,
      },
    }),
  );
  assert.equal(result, 'parent');
  assert.deepEqual(
    h.calls.map((call) => [call[0], call[2]]),
    [['vibe', 'PATCH']],
  );

  const none = harness();
  assert.equal(
    await none.reconcileGithubIssueParent(
      parentInput({ prefetchedParent: null }),
    ),
    null,
  );
  assert.equal(none.calls.length, 0);
});

function parentInput(overrides = {}) {
  const child = {
    issue_id: 'child',
    repository: 'example/app',
    number: 5,
    synced_parent_issue_id: null,
  };
  const parent = { issue_id: 'parent', repository: 'example/app', number: 3 };
  return {
    github: { config: { token: 'synthetic' } },
    vibe: {},
    apiBase: API,
    link: child,
    vibeIssue: {
      id: 'child',
      parent_issue_id: null,
      updated_at: '2026-01-02T00:00:00Z',
    },
    external: { id: 55, updated_at: '2026-01-01T00:00:00Z' },
    linksByIssueId: new Map([
      ['child', child],
      ['parent', parent],
    ]),
    linksByExternalKey: new Map([
      ['example/app#5', child],
      ['example/app#3', parent],
    ]),
    ...overrides,
  };
}

test('a GitHub write re-reads the parent and skips when the prefetch is stale', async () => {
  const vibeIssue = {
    id: 'child',
    parent_issue_id: 'parent',
    updated_at: '2026-01-02T00:00:00Z',
  };
  const requests = [];
  const withCurrentParent = (body) =>
    harness({
      fetch: async (url, options = {}) => {
        requests.push([url, options.method || 'GET']);
        if (url.endsWith('/parent'))
          return body === null
            ? { status: 404, ok: false, text: async () => '' }
            : { status: 200, ok: true, text: async () => JSON.stringify(body) };
        return { status: 201, ok: true, text: async () => '' };
      },
    });

  const fresh = withCurrentParent(null);
  assert.equal(
    await fresh.reconcileGithubIssueParent(
      parentInput({ vibeIssue, prefetchedParent: null }),
    ),
    'parent',
  );
  assert.deepEqual(requests.splice(0), [
    [`${API}/repos/example/app/issues/5/parent`, 'GET'],
    [`${API}/repos/example/app/issues/3/sub_issues`, 'POST'],
  ]);

  const stale = withCurrentParent({
    number: 9,
    repository_url: `${API}/repos/example/app`,
  });
  assert.equal(
    await stale.reconcileGithubIssueParent(
      parentInput({ vibeIssue, prefetchedParent: null }),
    ),
    undefined,
  );
  assert.deepEqual(requests, [
    [`${API}/repos/example/app/issues/5/parent`, 'GET'],
  ]);
});
