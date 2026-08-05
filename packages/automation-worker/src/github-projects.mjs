export const GITHUB_PROJECTS_METADATA_QUERY = `query($owner:String!) {
  repositoryOwner(login:$owner) {
    ... on Organization {
      projectsV2(first:50, orderBy:{field:UPDATED_AT,direction:DESC}) {
        nodes { ...ProjectMetadata }
      }
    }
    ... on User {
      projectsV2(first:50, orderBy:{field:UPDATED_AT,direction:DESC}) {
        nodes { ...ProjectMetadata }
      }
    }
  }
}

fragment ProjectMetadata on ProjectV2 {
  id number title
  fields(first:50) {
    nodes {
      ... on ProjectV2SingleSelectField {
        id name
        options { id name }
      }
    }
  }
}`;

export const GITHUB_PROJECT_ITEMS_QUERY = `query($project:ID!,$after:String) {
  node(id:$project) {
    ... on ProjectV2 {
      items(first:100, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            ... on Issue {
              id number title url state body updatedAt
              repository { nameWithOwner }
              author { login }
              assignees(first:20) { nodes { login } }
              milestone {
                number title dueOn state closedAt updatedAt
              }
            }
          }
        }
      }
    }
  }
}`;

// A Project board holds the whole team's issues, so the project source must
// reproduce the REST poll's ownership predicate. Without it a single poll
// imports everyone's issues and the status sync pushes the importing user's
// default column onto every board item.
export function ownsGithubProjectIssue(issue, login, filter) {
  const me = String(login || '').toLowerCase();
  if (!me) return false;
  const author = String(issue?.author?.login || '').toLowerCase();
  const assignees = (issue?.assignees?.nodes || []).map((node) =>
    String(node?.login || '').toLowerCase()
  );
  if (filter === 'created') return author === me;
  // Project items carry no mention data, so `mentioned` cannot be reproduced.
  // Narrow it to issues that are unambiguously the user's own instead of
  // falling back to "import everything".
  if (filter === 'mentioned') return author === me || assignees.includes(me);
  // 'assigned' and any unknown filter — mirrors the REST default.
  return assignees.includes(me);
}

export async function loadGithubProjectIssues(
  connector,
  projectId,
  repository,
  requestGraphql,
  scope = {}
) {
  const expectedRepository = String(repository).toLowerCase();
  const login = String(scope.login || '');
  // Fail closed: an unscoped load would import other people's issues.
  if (!login) return [];
  const filter = String(scope.filter || 'assigned');
  const stateFilter = String(scope.state || 'open').toLowerCase();
  const issues = [];
  let after = null;
  do {
    const data = await requestGraphql(connector, GITHUB_PROJECT_ITEMS_QUERY, {
      project: projectId,
      after,
    });
    const page = data?.node?.items;
    for (const item of page?.nodes || []) {
      const issue = item?.content;
      if (
        !issue?.number ||
        String(issue.repository?.nameWithOwner || '').toLowerCase() !==
          expectedRepository
      ) {
        continue;
      }
      if (!ownsGithubProjectIssue(issue, login, filter)) continue;
      if (
        stateFilter !== 'all' &&
        String(issue.state || '').toLowerCase() !== stateFilter
      ) {
        continue;
      }
      issues.push({
        id: issue.id,
        node_id: issue.id,
        number: issue.number,
        title: issue.title,
        html_url: issue.url,
        state: String(issue.state || '').toLowerCase(),
        body: issue.body ?? null,
        updated_at: issue.updatedAt,
        user: issue.author?.login ? { login: issue.author.login } : null,
        assignees: (issue.assignees?.nodes || [])
          .filter((node) => node?.login)
          .map((node) => ({ login: node.login })),
        labels: [],
        milestone: issue.milestone
          ? {
              number: issue.milestone.number,
              title: issue.milestone.title,
              due_on: issue.milestone.dueOn ?? null,
              state: String(issue.milestone.state || '').toLowerCase(),
              closed_at: issue.milestone.closedAt ?? null,
              updated_at: issue.milestone.updatedAt ?? null,
            }
          : null,
        __projectItem: true,
        project_item_id: item.id,
      });
    }
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return issues;
}

export async function loadGithubProjectsMetadata(connector, requestGraphql) {
  if (connector.type !== 'github') throw new Error('connector is not github');
  const owner = String(connector.config?.owner || '');
  const data = await requestGraphql(connector, GITHUB_PROJECTS_METADATA_QUERY, {
    owner,
  });
  const projects = data?.repositoryOwner?.projectsV2?.nodes || [];
  return {
    projects: projects.map((project) => {
      const statusField = (project.fields?.nodes || []).find(
        (field) => field && String(field.name).toLowerCase() === 'status'
      );
      return {
        id: project.id,
        number: project.number,
        title: project.title,
        statusField: statusField
          ? { id: statusField.id, options: statusField.options || [] }
          : null,
      };
    }),
  };
}
