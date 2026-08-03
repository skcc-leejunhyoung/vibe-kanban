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

export async function loadGithubProjectsMetadata(
  connector,
  requestGraphql
) {
  if (connector.type !== 'github') throw new Error('connector is not github');
  const owner = String(connector.config?.owner || '');
  const data = await requestGraphql(
    connector,
    GITHUB_PROJECTS_METADATA_QUERY,
    { owner }
  );
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
