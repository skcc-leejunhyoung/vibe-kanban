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

// Node IDs survive repository renames and transfers, so one nodes() read gives
// each linked issue's current address and parent (100 IDs per query, cost 1).
export const GITHUB_ISSUE_NODES_QUERY =
  'query($ids: [ID!]!) { nodes(ids: $ids) { ... on Issue { id number url repository { nameWithOwner } parent { number repository { nameWithOwner } } } } }';

// Node ID -> { repository, number, url, parent } for the IDs GitHub resolved,
// from a full GraphQL response ({ data, errors }). `parent` uses the REST shape
// (null = none, undefined = unknown) so callers treat it like a /parent
// response. IDs with an error are left out (REST fallback); an error not tied
// to one node distrusts the whole batch, since it may have blanked a parent.
export function parseGithubIssueNodes(ids, body, apiBase) {
  const nodes = Array.isArray(body?.data?.nodes) ? body.data.nodes : [];
  const failed = new Set();
  for (const error of Array.isArray(body?.errors) ? body.errors : []) {
    const [field, index] = Array.isArray(error?.path) ? error.path : [];
    if (field !== 'nodes' || !Number.isInteger(index)) return new Map();
    failed.add(index);
  }
  const result = new Map();
  ids.forEach((id, index) => {
    if (failed.has(index)) return;
    const node = nodes[index];
    const repository = node?.repository?.nameWithOwner;
    if (
      node?.id !== id ||
      typeof repository !== 'string' ||
      !repository.includes('/') ||
      !Number.isSafeInteger(node.number) ||
      typeof node.url !== 'string'
    )
      return;
    const parentRepository = node.parent?.repository?.nameWithOwner;
    let parent;
    if (node.parent === null) parent = null;
    else if (
      typeof parentRepository === 'string' &&
      Number.isSafeInteger(node.parent?.number)
    )
      parent = {
        number: node.parent.number,
        repository_url: `${apiBase}/repos/${parentRepository}`,
      };
    result.set(id, { repository, number: node.number, url: node.url, parent });
  });
  return result;
}

// The address GitHub now serves a linked issue at, or null when the link is
// current. Old addresses still work but every REST call through them pays an
// extra rate-limited 301.
export function githubIssueLinkRelocation(link, node) {
  if (!node || githubIssueLinkKey(node) === githubIssueLinkKey(link))
    return null;
  return { repository: node.repository, number: node.number, url: node.url };
}

// Old repository (lowercase) -> current name, only when every linked issue of
// it now lives under one new name with its number kept: the repository itself
// was renamed or transferred, so its milestones moved too. One issue still in
// place, renumbered or sent elsewhere means issues moved one by one.
export function githubRepositoryMoves(links, nodes) {
  const moves = new Map();
  const unmoved = new Set();
  for (const link of links) {
    const node = nodes.get(link.github_node_id);
    if (!node) continue;
    const from = String(link.repository || '').toLowerCase();
    const next = githubIssueLinkRelocation(link, node);
    const to = next?.number === Number(link.number) ? next.repository : null;
    if (
      !to ||
      (moves.has(from) && moves.get(from).toLowerCase() !== to.toLowerCase())
    )
      unmoved.add(from);
    else moves.set(from, to);
  }
  for (const from of unmoved) moves.delete(from);
  return moves;
}

export function githubIssueParentKey(parent) {
  if (!parent) return null;
  return githubIssueLinkKey({
    repository: githubIssueRepository(parent),
    number: parent.number,
  });
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
