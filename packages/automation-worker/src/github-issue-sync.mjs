const MARKER_PREFIX = '<!-- vibe-kanban-issue:';

export function githubIssueMarker(issueId) {
  return `${MARKER_PREFIX}${issueId} -->`;
}

export function withGithubIssueMarker(body, issueId) {
  const marker = githubIssueMarker(issueId);
  const text = body == null ? '' : String(body);
  if (text.includes(marker)) return text;
  return text ? `${text}\n\n${marker}` : marker;
}

export function withoutGithubIssueMarker(body) {
  if (body == null) return null;
  const cleaned = String(body)
    .replace(/(?:\r?\n){0,2}<!-- vibe-kanban-issue:[^>]+ -->/g, '')
    .trimEnd();
  return cleaned || null;
}

export function shouldSyncGithubProjectStatus(config) {
  return config?.fields?.status !== false;
}

export function githubIssueMapBackfillEntries({
  issueMap,
  repository,
  linkedIssueIds,
  skippedSourceKeys,
}) {
  const prefix = `${String(repository).toLowerCase()}#`;
  const linked = new Set(linkedIssueIds || []);
  const skipped = new Set(skippedSourceKeys || []);

  return Object.entries(issueMap || {}).flatMap(([sourceKey, issueId]) => {
    if (skipped.has(sourceKey) || linked.has(issueId)) return [];
    const normalized = sourceKey.toLowerCase();
    if (!normalized.startsWith(prefix)) return [];
    const number = Number(sourceKey.slice(sourceKey.lastIndexOf('#') + 1));
    if (!Number.isInteger(number) || number <= 0) return [];
    return [{ sourceKey, issueId, number }];
  });
}

export async function backfillLegacyGithubIssueLinks({
  entries,
  issues,
  repository,
  ruleId,
  linkIssue,
  onPullRequest,
  onFailure,
}) {
  const result = { linked: 0, skipped: 0, failed: 0 };
  for (const entry of entries) {
    const issue = issues.get(entry.issueId);
    if (!issue) continue;
    try {
      await linkIssue({
        ruleId,
        mode: 'existing',
        url: `https://github.com/${repository}/issues/${entry.number}`,
        issueId: issue.id,
        title: issue.title,
        description: issue.description,
        statusId: issue.status_id,
        vibeUpdatedAt: issue.updated_at,
      });
      result.linked += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('pull request URLs cannot be linked')) {
        await onPullRequest(entry);
        result.skipped += 1;
      } else {
        await onFailure(entry, issue, error);
        result.failed += 1;
      }
    }
  }
  return result;
}

export async function retryPendingGithubIssueLinkOperations({
  operations,
  connectorId,
  linkIssue,
  onFailure,
}) {
  let recovered = 0;
  for (const operation of operations) {
    if (operation.githubConnectorId !== connectorId) continue;
    try {
      await linkIssue(operation.input);
      recovered += 1;
    } catch (error) {
      await onFailure(operation, error);
    }
  }
  return recovered;
}

export async function ensureGithubIssueForLink({
  mode,
  issueId,
  url,
  title,
  description,
  operation,
  findCreatedIssue,
  createIssue,
  fetchExistingIssue,
  persistOperation,
}) {
  if (operation.githubIssue) return operation.githubIssue;

  let issue;
  if (mode === 'create') {
    issue = await findCreatedIssue(
      githubIssueMarker(issueId),
      operation.createdAt
    );
    if (!issue) {
      issue = await createIssue({
        title,
        body: withGithubIssueMarker(description, issueId),
      });
    }
  } else {
    issue = await fetchExistingIssue(url);
  }

  operation.githubIssue = issue;
  await persistOperation();
  return issue;
}

export async function runSingleFlight(inFlight, key, task) {
  const current = inFlight.get(key);
  if (current) return current;
  const promise = Promise.resolve().then(task);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  }
}
