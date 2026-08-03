import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GITHUB_PROJECTS_METADATA_QUERY,
  loadGithubProjectsMetadata,
} from './github-projects.mjs';

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
