export function githubIssueLinkKey(issue) {
  return `${String(issue.repository || '').toLowerCase()}#${Number(issue.number)}`;
}

export function githubIssueRepositoriesShareOwner(first, second) {
  const firstOwner = String(first || '').split('/', 1)[0].toLowerCase();
  const secondOwner = String(second || '').split('/', 1)[0].toLowerCase();
  return Boolean(firstOwner && secondOwner && firstOwner === secondOwner);
}

export function githubIssueRepository(issue) {
  const repositoryUrl = String(issue?.repository_url || '');
  const match = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)\/?$/i);
  return match
    ? `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`
    : null;
}

export async function fetchGithubIssueParent({
  fetchImpl,
  apiBase,
  link,
  headers,
}) {
  const response = await fetchImpl(
    `${apiBase}/repos/${link.repository}/issues/${link.number}/parent`,
    { headers }
  );
  if (response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub parent lookup error: ${response.status} ${text.slice(0, 200)}`
    );
  }
  return JSON.parse(text);
}

export async function canConfirmGithubParentRemoval({
  fetchImpl,
  apiBase,
  childLink,
  previousParentLink,
  headers,
}) {
  if (!previousParentLink) return false;
  if (
    String(childLink.repository).toLowerCase() ===
    String(previousParentLink.repository).toLowerCase()
  ) {
    return true;
  }

  const response = await fetchImpl(
    `${apiBase}/repos/${previousParentLink.repository}/issues/${previousParentLink.number}`,
    { headers }
  );
  const text = await response.text();
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `GitHub previous parent lookup error: ${response.status} ${text.slice(0, 200)}`
    );
  }
  return true;
}

export async function updateGithubIssueParent({
  fetchImpl,
  apiBase,
  child,
  currentParent,
  nextParentLink,
  headers,
}) {
  let response;
  if (nextParentLink) {
    response = await fetchImpl(
      `${apiBase}/repos/${nextParentLink.repository}/issues/${nextParentLink.number}/sub_issues`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sub_issue_id: child.id,
          replace_parent: true,
        }),
      }
    );
  } else if (currentParent) {
    const repository = githubIssueRepository(currentParent);
    if (!repository) throw new Error('GitHub parent returned no repository');
    response = await fetchImpl(
      `${apiBase}/repos/${repository}/issues/${currentParent.number}/sub_issue`,
      {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ sub_issue_id: child.id }),
      }
    );
  } else {
    return;
  }
  if (!response.ok) {
    throw new Error(
      `GitHub parent update error: ${response.status} ${(await response.text()).slice(0, 200)}`
    );
  }
}
