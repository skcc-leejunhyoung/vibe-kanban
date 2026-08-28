import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadGithubProjectIssues,
  GITHUB_PROJECTS_METADATA_QUERY,
  loadGithubProjectsMetadata,
} from './github-projects.mjs';

test('loads repository issues from every selected Project V2 item page', async () => {
  const calls = [];
  const pages = [
    {
      node: {
        items: {
          pageInfo: { hasNextPage: true, endCursor: 'next' },
          nodes: [
            {
              id: 'item-1',
              content: {
                id: 'issue-1',
                number: 7,
                title: 'Project issue',
                url: 'https://github.test/acme/repo/issues/7',
                state: 'OPEN',
                body: null,
                updatedAt: '2026-08-04T00:00:00Z',
                repository: { nameWithOwner: 'acme/repo' },
                author: { login: 'me' },
                assignees: { nodes: [{ login: 'me' }] },
                milestone: {
                  number: 2,
                  title: 'M2',
                  dueOn: '2026-08-31T00:00:00Z',
                  state: 'OPEN',
                  closedAt: null,
                  updatedAt: '2026-08-04T00:00:00Z',
                },
              },
            },
          ],
        },
      },
    },
    {
      node: {
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  ];
  const issues = await loadGithubProjectIssues(
    { type: 'github' },
    'project-1',
    'acme/repo',
    async (_connector, _query, variables) => {
      calls.push(variables);
      return pages.shift();
    },
    { login: 'me', filter: 'assigned', state: 'open' }
  );
  assert.equal(calls.length, 2);
  assert.equal(issues[0].number, 7);
  assert.equal(issues[0].milestone.number, 2);
  assert.equal(issues[0].__projectItem, true);
  assert.equal(issues[0].project_item_id, 'item-1');
  assert.deepEqual(issues[0].assignees, [{ login: 'me' }]);
  assert.deepEqual(issues[0].user, { login: 'me' });
});

function projectItemPage(nodes) {
  return {
    node: { items: { pageInfo: { hasNextPage: false }, nodes } },
  };
}

function projectItem(number, overrides = {}) {
  return {
    id: `item-${number}`,
    content: {
      id: `issue-${number}`,
      number,
      title: `Issue ${number}`,
      url: `https://github.test/acme/repo/issues/${number}`,
      state: 'OPEN',
      body: null,
      updatedAt: '2026-08-04T00:00:00Z',
      repository: { nameWithOwner: 'acme/repo' },
      author: { login: 'someone-else' },
      assignees: { nodes: [{ login: 'someone-else' }] },
      milestone: null,
      ...overrides,
    },
  };
}

test('imports only the connector user own project items', async () => {
  // 프로젝트 아이템은 REST 폴링과 같은 소유자 술어로 좁힌다. 무스코프로 끌어오면
  // 남의 이슈까지 보드로 들어와 상태 역푸시로 프로젝트 전체를 덮어쓴다(#5603 회귀).
  const cases = [
    { filter: 'assigned', mine: { assignees: { nodes: [{ login: 'me' }] } } },
    { filter: 'created', mine: { author: { login: 'me' } } },
    { filter: 'mentioned', mine: { author: { login: 'me' } } },
  ];
  for (const { filter, mine } of cases) {
    const issues = await loadGithubProjectIssues(
      { type: 'github' },
      'project-1',
      'acme/repo',
      async () => projectItemPage([projectItem(1), projectItem(2, mine)]),
      { login: 'me', filter, state: 'open' }
    );
    assert.deepEqual(
      issues.map((issue) => issue.number),
      [2],
      `filter=${filter}`
    );
  }
});

test('imports no project items when the poll scope has no login', async () => {
  const issues = await loadGithubProjectIssues(
    { type: 'github' },
    'project-1',
    'acme/repo',
    async () =>
      projectItemPage([
        projectItem(1, { assignees: { nodes: [{ login: 'me' }] } }),
      ]),
    { filter: 'assigned', state: 'open' }
  );
  assert.deepEqual(issues, []);
});

test('applies the connector state filter to project items', async () => {
  const nodes = [
    projectItem(1, {
      state: 'CLOSED',
      assignees: { nodes: [{ login: 'me' }] },
    }),
    projectItem(2, { assignees: { nodes: [{ login: 'me' }] } }),
  ];
  const load = (state) =>
    loadGithubProjectIssues(
      { type: 'github' },
      'project-1',
      'acme/repo',
      async () => projectItemPage(nodes),
      { login: 'me', filter: 'assigned', state }
    );
  assert.deepEqual(
    (await load('open')).map((i) => i.number),
    [2]
  );
  assert.deepEqual(
    (await load('closed')).map((i) => i.number),
    [1]
  );
  assert.deepEqual(
    (await load('all')).map((i) => i.number),
    [1, 2]
  );
});

test('optionally imports assigned issues from other repositories', async () => {
  const load = (includeOtherRepositories) =>
    loadGithubProjectIssues(
    { type: 'github' },
    'project-1',
    'acme/repo',
    async () =>
      projectItemPage([
        projectItem(1, {
          repository: { nameWithOwner: 'acme/other' },
          assignees: { nodes: [{ login: 'me' }] },
        }),
      ]),
      {
        login: 'me',
        filter: 'assigned',
        state: 'open',
        includeOtherRepositories,
      }
    );
  assert.deepEqual(await load(false), []);
  const issues = await load(true);
  assert.equal(issues[0].repository, 'acme/other');
  assert.equal(issues[0].__externalRepository, true);
});

test('queries projects for both organization and user owners', async () => {
  let capturedQuery = '';
  let capturedVariables = null;
  const result = await loadGithubProjectsMetadata(
    { type: 'github', config: { owner: 'example' } },
    async (_connector, query, variables) => {
      capturedQuery = query;
      capturedVariables = variables;
      return {
        repositoryOwner: {
          projectsV2: {
            nodes: [
              {
                id: 'project-1',
                number: 1,
                title: 'Roadmap',
                fields: {
                  nodes: [
                    {
                      id: 'status-field',
                      name: 'Status',
                      options: [{ id: 'todo', name: 'Todo' }],
                    },
                  ],
                },
              },
            ],
          },
        },
      };
    }
  );

  assert.match(capturedQuery, /\.\.\. on Organization/);
  assert.match(capturedQuery, /\.\.\. on User/);
  assert.deepEqual(capturedVariables, { owner: 'example' });
  assert.deepEqual(result, {
    projects: [
      {
        id: 'project-1',
        number: 1,
        title: 'Roadmap',
        statusField: {
          id: 'status-field',
          options: [{ id: 'todo', name: 'Todo' }],
        },
      },
    ],
  });
});

test('keeps projects without a Status field selectable', async () => {
  const result = await loadGithubProjectsMetadata(
    { type: 'github', config: { owner: 'example' } },
    async () => ({
      repositoryOwner: {
        projectsV2: {
          nodes: [
            {
              id: 'project-1',
              number: 1,
              title: 'Roadmap',
              fields: { nodes: [] },
            },
          ],
        },
      },
    })
  );

  assert.equal(result.projects[0].statusField, null);
});

test('exports a GraphQL document with a shared ProjectV2 fragment', () => {
  assert.match(GITHUB_PROJECTS_METADATA_QUERY, /fragment ProjectMetadata/);
});
