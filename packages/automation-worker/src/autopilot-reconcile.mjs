import { createHash } from 'node:crypto';

const sha = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = (rows) =>
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sha1 = /^[0-9a-f]{40}$/i;

export function validateReconciliationScope(scope, repositories) {
  if (
    !scope ||
    !uuid.test(scope.projectId) ||
    !uuid.test(scope.reviewTagId) ||
    !Array.isArray(scope.hosts) ||
    !scope.hosts.length ||
    scope.hosts.length > 8 ||
    scope.hosts.some(
      (host) => typeof host !== 'string' || !host || host.length > 200
    ) ||
    !Array.isArray(scope.tracked) ||
    scope.tracked.length > 2000 ||
    !/^[0-9a-f]{64}$/i.test(scope.registryHash || '')
  )
    throw new Error('invalid reconciliation scope');
  if (
    scope.ignoreWorkspaces !== undefined &&
    (!Array.isArray(scope.ignoreWorkspaces) ||
      scope.ignoreWorkspaces.length > 2000 ||
      scope.ignoreWorkspaces.some((id) => !uuid.test(id)))
  )
    throw new Error('invalid excluded workspace scope');
  for (const pr of scope.tracked) {
    if (
      !repositories.includes(pr.repository) ||
      !Number.isSafeInteger(pr.number) ||
      pr.number < 1
    )
      throw new Error(
        'tracked PR is outside the configured repository allowlist'
      );
  }
}

// A review identity participates even if its head did not change. Never infer approval.
export function decisionReviews(reviews, head) {
  const latest = new Map();
  for (const review of reviews) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state))
      continue;
    if (
      !Number.isSafeInteger(review.id) ||
      !review.user?.login ||
      !Number.isFinite(Date.parse(review.submitted_at)) ||
      !sha1.test(review.commit_id)
    )
      throw new Error('invalid decision review');
    const key = review.user.login.toLowerCase();
    const row = {
      reviewer: key,
      id: review.id,
      state: review.state,
      head: review.commit_id,
      at: review.submitted_at,
    };
    const previous = latest.get(key);
    if (!previous || Date.parse(row.at) > Date.parse(previous.at))
      latest.set(key, row);
    else if (
      Date.parse(row.at) === Date.parse(previous.at) &&
      row.id !== previous.id
    )
      latest.set(key, {
        ...previous,
        state: 'UNDETERMINED',
        ids: [...new Set([...(previous.ids || [previous.id]), row.id])].sort(
          (a, b) => a - b
        ),
      });
  }
  return sorted(
    [...latest.values()].map((row) => ({
      ...row,
      current: row.head === head && row.state !== 'UNDETERMINED',
    }))
  );
}

export async function collectReconciliation({
  scope,
  repositories,
  github,
  discover,
  vibe,
  host,
  now = Date.now,
}) {
  validateReconciliationScope(scope, repositories);
  const prs = new Map(
    scope.tracked.map((pr) => [`${pr.repository}#${pr.number}`, pr])
  );
  for (const repository of repositories) {
    for (const pr of await discover(repository)) {
      if (
        pr.repository !== repository ||
        !Number.isSafeInteger(pr.number) ||
        pr.number < 1
      )
        throw new Error('invalid review discovery');
      prs.set(`${repository}#${pr.number}`, { repository, number: pr.number });
    }
  }
  const issues = [];
  let total;
  for (let offset = 0; ; offset += 100) {
    const page = await vibe('POST', '/v1/issues/search', {
      project_id: scope.projectId,
      tag_id: scope.reviewTagId,
      limit: 100,
      offset,
      sort_field: 'created_at',
      sort_direction: 'asc',
    });
    if (
      !Array.isArray(page.issues) ||
      !Number.isSafeInteger(page.total_count) ||
      page.total_count < 0 ||
      (total !== undefined && total !== page.total_count) ||
      page.offset !== offset ||
      page.issues.length > 100 ||
      page.issues.length !==
        Math.min(100, Math.max(0, page.total_count - offset))
    )
      throw new Error('incomplete issue discovery');
    total = page.total_count;
    for (const issue of page.issues) {
      if (
        !uuid.test(issue.id) ||
        issue.project_id !== scope.projectId ||
        issues.some((row) => row.id === issue.id)
      )
        throw new Error('invalid issue discovery');
      const links = await vibe('GET', `/v1/pull_requests?issue_id=${issue.id}`);
      if (!Array.isArray(links.pull_requests))
        throw new Error('incomplete linked PR discovery');
      const urls = [];
      for (const pr of links.pull_requests) {
        const match =
          /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(
            pr.url || ''
          );
        if (!match || !repositories.includes(match[1].toLowerCase()))
          throw new Error('linked PR outside allowlist');
        const ref = {
          repository: match[1].toLowerCase(),
          number: Number(match[2]),
        };
        prs.set(`${ref.repository}#${ref.number}`, ref);
        urls.push(pr.url);
      }
      issues.push({
        id: issue.id,
        status_id: issue.status_id,
        updated_at: issue.updated_at,
        completed_at: issue.completed_at,
        prs: urls.sort(),
      });
    }
    if (offset + page.issues.length >= total) break;
    if (offset >= 100000)
      throw new Error('issue discovery exceeds reconciliation limit');
  }
  const heads = [];
  for (const [key, pr] of [...prs].sort(([a], [b]) => a.localeCompare(b))) {
    const path = `/repos/${pr.repository}/pulls/${pr.number}`;
    const before = await github(path);
    if (!sha1.test(before.head?.sha)) throw new Error('invalid PR head');
    const reviews = [];
    for (let page = 1; ; page++) {
      const rows = await github(`${path}/reviews?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('incomplete reviews');
      reviews.push(...rows);
      if (rows.length < 100) break;
      if (page >= 1000) throw new Error('review pagination limit');
    }
    const after = await github(path);
    if (
      before.head.sha !== after.head?.sha ||
      before.state !== after.state ||
      before.updated_at !== after.updated_at
    )
      throw new Error('PR changed during reconciliation');
    heads.push({
      key,
      head: before.head.sha,
      state: before.state,
      draft: before.draft,
      updated_at: before.updated_at,
      reviewEvents: sorted(
        reviews.map((review) => {
          if (
            !Number.isSafeInteger(review.id) ||
            typeof review.state !== 'string'
          )
            throw new Error('invalid review event');
          return {
            id: review.id,
            state: review.state,
            head: review.commit_id,
            at: review.submitted_at,
          };
        })
      ),
      reviews: decisionReviews(reviews, before.head.sha),
    });
  }
  const hosts = [];
  let requiresAgent = false;
  for (const machineId of [...new Set(scope.hosts)].sort()) {
    const snapshot = await host(machineId);
    if (
      snapshot?.hostId !== machineId ||
      snapshot.complete !== true ||
      !Array.isArray(snapshot.workspaces)
    )
      throw new Error('incomplete host snapshot');
    const ignored = new Set(scope.ignoreWorkspaces || []);
    const workspaces = snapshot.workspaces.filter(
      (row) => !ignored.has(row.id)
    );
    for (const workspace of workspaces) {
      for (const session of workspace.sessions || []) {
        if (!session.pending_resumes) continue;
        if (
          !Array.isArray(session.resumes) ||
          session.resumes.length !== session.pending_resumes
        )
          throw new Error('incomplete resume snapshot');
        for (const resume of session.resumes) {
          const due = Date.parse(resume.due_at);
          if (
            !uuid.test(resume.id) ||
            !['scheduled', 'rate_limit'].includes(resume.kind) ||
            !/^[0-9a-f]{64}$/i.test(resume.content_hash) ||
            !Number.isFinite(due)
          )
            throw new Error('invalid resume snapshot');
          if (due <= now()) requiresAgent = true;
        }
      }
    }
    hosts.push({
      machineId,
      workspaces: sorted(workspaces),
    });
  }
  const facts = {
    registryHash: scope.registryHash,
    issues: sorted(issues),
    heads,
    hosts,
  };
  return {
    facts,
    fingerprint: sha(facts),
    requiresAgent,
    counts: { issues: issues.length, prs: heads.length, hosts: hosts.length },
  };
}

// Only an official, later agent checkpoint can acknowledge a changed baseline.
export async function reconcileAutopilot({
  scope,
  record,
  collect,
  persist,
  acknowledgedAt,
  now = Date.now,
}) {
  const snapshot = await collect();
  const at = new Date(now()).toISOString();
  const acknowledged = Date.parse(acknowledgedAt);
  const pendingAt = Date.parse(record.pending?.at);
  if (
    record.pending?.fingerprint === snapshot.fingerprint &&
    Number.isFinite(acknowledged) &&
    acknowledged >= pendingAt &&
    acknowledged <= now() &&
    now() - acknowledged < 2 * 60 * 60 * 1000
  )
    record.baseline = { fingerprint: snapshot.fingerprint, at: acknowledgedAt };
  const changed =
    snapshot.requiresAgent === true ||
    record.baseline?.fingerprint !== snapshot.fingerprint;
  record.pending = {
    at,
    fingerprint: snapshot.fingerprint,
    counts: snapshot.counts,
  };
  record.checkedAt = at;
  await persist();
  return {
    status: 'ok',
    changed,
    errors: [],
    summary: changed
      ? 'Fresh facts need agent reconciliation'
      : 'Registered PRs, review discovery and host queues are unchanged',
    checkedAt: at,
    counts: snapshot.counts,
    fingerprint: snapshot.fingerprint,
  };
}
