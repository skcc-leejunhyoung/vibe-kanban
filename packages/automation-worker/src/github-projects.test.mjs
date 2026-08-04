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
    }
  );
  assert.equal(calls.length, 2);
  assert.equal(issues[0].number, 7);
  assert.equal(issues[0].milestone.number, 2);
  assert.equal(issues[0].__projectItem, true);
  assert.equal(issues[0].project_item_id, 'item-1');
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
