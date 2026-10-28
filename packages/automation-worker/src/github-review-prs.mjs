import { createHash } from 'node:crypto';
import {
  githubIssueRepository,
  githubIssueLinkKey,
} from './github-sub-issues.mjs';

// An explicit allowlist, never an organization-wide search or credential change.
export function githubReviewRepositories(config) {
  const configured = config.reviewRepositories;
  if (configured !== undefined && !Array.isArray(configured)) {
    throw new Error('reviewRepositories must be an array of owner/repo names');
  }
  const repositories = configured?.length
    ? configured
    : config.owner && config.repo
      ? [`${config.owner}/${config.repo}`]
      : [];
  return [
    ...new Set(
      repositories.map((repository) => {
        if (
          typeof repository !== 'string' ||
          !/^[a-z0-9_-]+\/[a-z0-9_.-]+$/i.test(repository.trim()) ||
          ['.', '..'].includes(repository.trim().split('/')[1])
        ) {
          throw new Error(
            'Each review repository must be an explicit owner/repo name'
          );
        }
        return repository.trim().toLowerCase();
      })
    ),
  ];
}

export async function searchGithubPrs({
  fetchImpl,
  apiBase,
  headers,
  repository,
  qualifier,
  perPage,
  reviewLogin,
}) {
  const prs = new Map();
  for (let page = 1; ; page += 1) {
    const params = new URLSearchParams({
      q: `repo:${repository} is:pr ${qualifier}`,
      per_page: String(perPage),
      page: String(page),
      sort: 'updated',
      order: 'desc',
    });
    const response = await fetchImpl(`${apiBase}/search/issues?${params}`, {
      headers,
    });
    if (!response.ok)
      throw new Error(
        `GitHub PR search failed for ${repository}: ${response.status}`
      );
    const body = await response.json();
    // GitHub search cannot page beyond 1000. Never publish a partial snapshot
    // as a successful reconciliation (including a timed-out search response).
    if (
      body.incomplete_results ||
      body.total_count > 1000 ||
      !Array.isArray(body.items)
    ) {
      if (reviewLogin)
        return listGithubReviewPrs({
          fetchImpl,
          apiBase,
          headers,
          repository,
          reviewLogin,
        });
      throw new Error(`Incomplete GitHub PR search for ${repository}`);
    }
    for (const item of body.items) {
      const source = githubIssueRepository(item)?.toLowerCase();
      if (source !== repository.toLowerCase()) {
        throw new Error(
          `GitHub PR search returned an unexpected repository for ${repository}`
        );
      }
      const pr = { ...item, repository: source };
      prs.set(githubIssueLinkKey(pr), pr);
    }
    if (body.items.length < perPage || page * perPage >= body.total_count)
      break;
    if (page * perPage >= 1000)
      throw new Error(`GitHub PR search pagination limit for ${repository}`);
  }
  return [...prs.values()];
}

// Search is capped and can time out. The same repository's open-PR endpoint
// supplies direct requested_reviewers without a search-index limit.
async function listGithubReviewPrs({
  fetchImpl,
  apiBase,
  headers,
  repository,
  reviewLogin,
}) {
  const prs = new Map();
  for (let page = 1; ; page += 1) {
    const params = new URLSearchParams({
      state: 'open',
      per_page: '100',
      page: String(page),
    });
    const response = await fetchImpl(
      `${apiBase}/repos/${repository}/pulls?${params}`,
      { headers }
    );
    if (!response.ok)
      throw new Error(
        `GitHub review PR list failed for ${repository}: ${response.status}`
      );
    const items = await response.json();
    if (!Array.isArray(items))
      throw new Error(`Invalid GitHub review PR list for ${repository}`);
    for (const item of items) {
      const source = String(item.base?.repo?.full_name || '').toLowerCase();
      if (source !== repository.toLowerCase())
        throw new Error(
          `GitHub PR list returned an unexpected repository for ${repository}`
        );
      if (
        item.draft ||
        !(item.requested_reviewers || []).some(
          (reviewer) =>
            String(reviewer.login).toLowerCase() === reviewLogin.toLowerCase()
        )
      )
        continue;
      const pr = { ...item, repository: source };
      prs.set(githubIssueLinkKey(pr), pr);
    }
    if (items.length < 100) break;
  }
  return [...prs.values()];
}

// The API accepts a client UUID. A lost response or server restart can then be
// recovered by GET, without a separate non-atomic action receipt.
export function githubReviewIssueId(projectId, url) {
  const bytes = createHash('sha256')
    .update(`${projectId}:${url.toLowerCase()}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function githubReviewRuleVersion(rule) {
  return createHash('sha256')
    .update(JSON.stringify([rule.script, rule.config || {}]))
    .digest('hex');
}

// Independent of issue cursors/seed/seenIds: old, newly requested reviews and
// previously seeded misses are reconciled against actual PR→issue links.
export async function reconcileGithubReviewPrs({
  config,
  repositories,
  loadPrs,
  loadHead,
  findTracking,
  pendingRetry,
  emit,
  persist,
}) {
  const rows = [];
  const errors = [];
  let processed = 0;
  const heads = (config.reviewPrHeads ||= {});
  for (const repository of repositories) {
    try {
      const prs = await loadPrs(repository);
      for (const pr of prs) {
        try {
          const key = githubIssueLinkKey(pr);
          const head = await loadHead(pr);
          const previousHeadSha = heads[key]?.headSha || null;
          let tracking = await findTracking(pr, head);
          const retry = pendingRetry(pr);
          if ((!tracking || tracking.needsDelivery) && !retry) {
            await emit({ ...pr, ...head, type: 'pr' });
            processed += 1;
            tracking = await findTracking(pr, head);
          }
          if (tracking && previousHeadSha && previousHeadSha !== head.headSha) {
            await emit({ ...pr, ...head, type: 'pr_updated', previousHeadSha });
          }
          heads[key] = head;
          for (const target of tracking?.targets || []) {
            if (target.error)
              errors.push({
                repository,
                number: pr.number,
                connectorId: target.connectorId,
                ruleId: target.ruleId,
                error: target.error,
              });
          }
          rows.push({
            repository,
            number: pr.number,
            url: pr.html_url,
            ...head,
            issueId: tracking?.issueId || null,
            targets: tracking?.targets || [],
            status: tracking?.linked
              ? 'tracked'
              : pendingRetry(pr) || (tracking ? 'link_pending' : 'untracked'),
          });
          await persist();
        } catch (error) {
          errors.push({
            repository,
            number: pr.number,
            error: String(error.message || error),
          });
          rows.push({
            repository,
            number: pr.number,
            url: pr.html_url,
            headSha: null,
            issueId: null,
            status: 'error',
            error: String(error.message || error),
          });
        }
      }
    } catch (error) {
      errors.push({ repository, error: String(error.message || error) });
    }
  }
  const snapshot = {
    checkedAt: new Date().toISOString(),
    repositories,
    complete: errors.length === 0,
    open: rows,
    missing: rows.filter((row) => row.status !== 'tracked'),
    errors,
  };
  config.reviewPrReconciliation = snapshot;
  await persist();
  return { processed, ...snapshot };
}
