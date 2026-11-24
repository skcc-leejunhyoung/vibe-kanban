import { createHash } from 'node:crypto';

const sha = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = (rows) =>
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sha1 = /^[0-9a-f]{40}$/i;
const SOURCE_READ_CONCURRENCY = 8;
const TERMINAL_REVIEW_AUDIT_MS = 2 * 60 * 60 * 1000;
// Expired terminal audits re-read per run, oldest first; the rest wait for a
// later run so a burst of expiries cannot push a run past its deadline.
const TERMINAL_REFRESH_LIMIT = 60;
const BOARD_DECISION_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'DISMISSED',
]);

// The account's REST budget is shared with `gh` and every other automation;
// reconciliation never spends the last `reserve` calls.
export class GithubBudgetLow extends Error {
  constructor(remaining, reserve) {
    super('GitHub rate budget below reserve');
    this.remaining = remaining;
    this.reserve = reserve;
  }
}

export function checkGithubBudget(remaining, reserve) {
  if (Number.isFinite(remaining) && remaining < reserve)
    throw new GithubBudgetLow(remaining, reserve);
}

export const reconciliationProjects = (scope) =>
  scope.projects === undefined ? [scope] : scope.projects;

const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

// Repositories whose tracked and linked PRs may be read: the review-discovery
// allowlist plus the scope's read-only extras (another repository a board row
// tracks, or an old name GitHub redirects). Discovery stays on the allowlist.
export function readableRepositories(scope, repositories) {
  const extra = scope.readRepositories ?? [];
  if (
    !Array.isArray(extra) ||
    extra.length > 16 ||
    extra.some((repository) => typeof repository !== 'string' || !REPOSITORY.test(repository))
  )
    throw new Error('invalid read-only repositories');
  return [...new Set([...repositories, ...extra])];
}

async function readBatches(items, read, signal) {
  const result = [];
  for (let i = 0; i < items.length; i += SOURCE_READ_CONCURRENCY) {
    signal?.throwIfAborted();
    const batch = await Promise.allSettled(
      items.slice(i, i + SOURCE_READ_CONCURRENCY).map(read)
    );
    for (const row of batch) {
      if (row.status === 'rejected') throw row.reason;
      result.push(row.value);
    }
  }
  return result;
}

// Activity timestamps move with every log line or comment; status, queue and
// resumes are the facts the Autopilot reconciles.
const hostFacts = ({ updated_at, sessions, ...workspace }) => ({
  ...workspace,
  sessions: (sessions || []).map(({ executions, ...session }) => ({
    ...session,
    executions: (executions || []).map(
      ({ updated_at: _, ...execution }) => execution
    ),
  })),
});

function prVersion(pr) {
  if (
    !Number.isSafeInteger(pr?.id) ||
    pr.id < 1 ||
    !sha1.test(pr.head?.sha || '') ||
    !['open', 'closed'].includes(pr.state) ||
    !Number.isFinite(Date.parse(pr.updated_at))
  )
    throw new Error('invalid PR identity or head');
  return sha([pr.id, pr.head.sha, pr.state, pr.draft, pr.updated_at]);
}

export function validateReconciliationScope(scope, repositories) {
  if (
    !scope ||
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
  const projects = reconciliationProjects(scope);
  if (
    !Array.isArray(projects) ||
    !projects.length ||
    projects.length > 16 ||
    projects.some(
      (item) => !uuid.test(item?.projectId) || !uuid.test(item?.reviewTagId)
    ) ||
    new Set(projects.map(({ projectId }) => projectId)).size !== projects.length
  )
    throw new Error('invalid reconciliation projects');
  if (
    scope.ignoreWorkspaces !== undefined &&
    (!Array.isArray(scope.ignoreWorkspaces) ||
      scope.ignoreWorkspaces.length > 2000 ||
      scope.ignoreWorkspaces.some((id) => !uuid.test(id)))
  )
    throw new Error('invalid excluded workspace scope');
  if (
    scope.watchSessions !== undefined &&
    (!Array.isArray(scope.watchSessions) ||
      scope.watchSessions.length > 5000 ||
      scope.watchSessions.some((id) => !uuid.test(id)))
  )
    throw new Error('invalid watched session scope');
  const readable = readableRepositories(scope, repositories);
  const trackedKeys = new Set();
  for (const pr of scope.tracked) {
    if (
      !readable.includes(pr.repository) ||
      !Number.isSafeInteger(pr.number) ||
      pr.number < 1
    )
      throw new Error(
        'tracked PR is outside the configured repository allowlist'
      );
    trackedKeys.add(`${pr.repository}#${pr.number}`);
  }
  if (
    scope.boardPrs !== undefined &&
    (!Array.isArray(scope.boardPrs) ||
      scope.boardPrs.length > 2000 ||
      scope.boardPrs.some((key) => !trackedKeys.has(key)))
  )
    throw new Error('review board entries must be tracked PRs');
  if (
    scope.boardNoteId !== undefined &&
    (typeof scope.boardNoteId !== 'string' || !uuid.test(scope.boardNoteId))
  )
    throw new Error('invalid review board note');
}

// A review identity participates even if its head did not change. Never infer approval.
export function decisionReviews(reviews, head) {
  const latest = new Map();
  for (const review of reviews) {
    if (!BOARD_DECISION_STATES.has(review.state)) continue;
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
  terminalReviews = {},
  signal,
}) {
  validateReconciliationScope(scope, repositories);
  const readable = readableRepositories(scope, repositories);
  const prs = new Map(
    scope.tracked.map((pr) => [`${pr.repository}#${pr.number}`, pr])
  );
  // GitHub's "Awaiting review from you" (`review-requested:`) set.
  const awaiting = new Set();
  for (const repository of repositories) {
    signal?.throwIfAborted();
    for (const pr of await discover(repository)) {
      if (
        pr.repository !== repository ||
        !Number.isSafeInteger(pr.number) ||
        pr.number < 1
      )
        throw new Error('invalid review discovery');
      prs.set(`${repository}#${pr.number}`, { repository, number: pr.number });
      awaiting.add(`${repository}#${pr.number}`);
    }
  }
  const issues = [];
  const issueIds = new Set();
  for (const project of reconciliationProjects(scope)) {
    signal?.throwIfAborted();
    const tag = await vibe(
      'GET',
      `/v1/tags/${project.reviewTagId}`,
      undefined,
      project
    );
    if (tag?.id !== project.reviewTagId || tag.project_id !== project.projectId)
      throw new Error('missing review tag for project');
    let total;
    for (let offset = 0; ; offset += 100) {
      signal?.throwIfAborted();
      const page = await vibe(
        'POST',
        '/v1/issues/search',
        {
          project_id: project.projectId,
          tag_id: project.reviewTagId,
          limit: 100,
          offset,
          sort_field: 'created_at',
          sort_direction: 'asc',
        },
        project
      );
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
          issue.project_id !== project.projectId ||
          issueIds.has(issue.id)
        )
          throw new Error('invalid issue discovery');
        issueIds.add(issue.id);
      }
      const pageIssues = await readBatches(
        page.issues,
        async (issue) => {
          const links = await vibe(
            'GET',
            `/v1/pull_requests?issue_id=${issue.id}`,
            undefined,
            project
          );
          if (!Array.isArray(links.pull_requests))
            throw new Error('incomplete linked PR discovery');
          const urls = [];
          for (const pr of links.pull_requests) {
            const match =
              /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(
                pr.url || ''
              );
            if (
              !match ||
              !readable.includes(match[1].toLowerCase()) ||
              !Number.isSafeInteger(Number(match[2])) ||
              Number(match[2]) < 1
            )
              throw new Error('linked PR outside allowlist');
            const ref = {
              repository: match[1].toLowerCase(),
              number: Number(match[2]),
            };
            prs.set(`${ref.repository}#${ref.number}`, ref);
            urls.push(pr.url);
          }
          return {
            id: issue.id,
            status_id: issue.status_id,
            completed_at: issue.completed_at,
            prs: urls.sort(),
          };
        },
        signal
      );
      issues.push(...pageIssues);
      if (offset + page.issues.length >= total) break;
      if (offset >= 100000)
        throw new Error('issue discovery exceeds reconciliation limit');
    }
  }
  const references = await readBatches(
    [...prs].sort(([a], [b]) => a.localeCompare(b)),
    async ([key, pr]) => {
      const path = `/repos/${pr.repository}/pulls/${pr.number}`;
      const before = await github(path);
      return { key, path, before, version: prVersion(before) };
    },
    signal
  );
  const identities = new Map();
  for (const reference of references) {
    const id = reference.before.id;
    const existing = identities.get(id);
    if (existing && existing.version !== reference.version)
      throw new Error('PR changed during alias resolution');
    if (existing) existing.aliases.push(reference.key);
    else identities.set(id, { ...reference, aliases: [] });
  }
  const audited = {};
  const fresh = (entry) =>
    now() - entry.auditedAt >= 0 &&
    now() - entry.auditedAt < TERMINAL_REVIEW_AUDIT_MS;
  const refresh = new Set(
    [...identities.values()]
      .map(({ before, version }) => [before, terminalReviews[before.id], version])
      .filter(
        ([before, previous, version]) =>
          before.state === 'closed' &&
          previous?.version === version &&
          !fresh(previous)
      )
      .sort(([, a], [, b]) => (a.auditedAt || 0) - (b.auditedAt || 0))
      .slice(0, TERMINAL_REFRESH_LIMIT)
      .map(([before]) => before.id)
  );
  const heads = await readBatches(
    [...identities.values()],
    async ({ key, aliases, path, before, version }) => {
      // A re-request changes this even when the head and reviews do not.
      const awaitingReview = [key, ...aliases].some((ref) => awaiting.has(ref));
      const previous = terminalReviews[before.id];
      // Always refresh identity, head and state; reopening must invalidate the audit immediately.
      if (
        before.state === 'closed' &&
        previous?.version === version &&
        !refresh.has(before.id)
      ) {
        audited[before.id] = previous;
        // Facts cached before `updated_at` left the comparison drop it here.
        const { updated_at: _, ...facts } = previous.facts;
        return { ...facts, key, aliases, awaitingReview };
      }
      const reviews = [];
      for (let page = 1; ; page++) {
        signal?.throwIfAborted();
        const rows = await github(`${path}/reviews?per_page=100&page=${page}`);
        if (!Array.isArray(rows)) throw new Error('incomplete reviews');
        reviews.push(...rows);
        if (rows.length < 100) break;
        if (page >= 1000) throw new Error('review pagination limit');
      }
      const after = await github(path);
      if (version !== prVersion(after))
        throw new Error('PR changed during reconciliation');
      const facts = {
        key,
        aliases,
        id: before.id,
        head: before.head.sha,
        state: before.state,
        draft: before.draft,
        awaitingReview,
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
      };
      if (before.state === 'closed')
        audited[before.id] = { version, auditedAt: now(), facts };
      return facts;
    },
    signal
  );
  const hosts = [];
  let requiresAgent = false;
  // Registered review sessions; other workspaces still count for due resumes.
  const watched =
    scope.watchSessions &&
    new Set(scope.watchSessions.map((id) => id.toLowerCase()));
  for (const machineId of [...new Set(scope.hosts)].sort()) {
    signal?.throwIfAborted();
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
      workspaces: sorted(
        workspaces
          .filter(
            (row) =>
              !watched ||
              (row.sessions || []).some((session) =>
                watched.has(String(session.id).toLowerCase())
              )
          )
          .map(hostFacts)
      ),
    });
  }
  signal?.throwIfAborted();
  const facts = {
    coverage: {
      projects: sorted(
        reconciliationProjects(scope).map(({ projectId, reviewTagId }) => ({
          projectId,
          reviewTagId,
        }))
      ),
      repositories: [...new Set(repositories)].sort(),
      hosts: hosts.map(({ machineId }) => machineId),
    },
    registryHash: scope.registryHash,
    boardNoteId: scope.boardNoteId,
    boardPrs: scope.boardPrs?.toSorted(),
    issues: sorted(issues),
    heads,
    hosts,
  };
  const boardRows = new Map();
  if (
    scope.boardNoteId &&
    Array.isArray(scope.boardResolutions) &&
    scope.boardResolutions.some((row) => row?.disposition === 'published')
  ) {
    try {
      const note = await vibe('GET', `/v1/drawer_notes/${scope.boardNoteId}`);
      if (
        typeof note?.id === 'string' &&
        note.id.toLowerCase() === scope.boardNoteId.toLowerCase() &&
        !note.archived_at &&
        typeof note.body === 'string'
      ) {
        for (const line of note.body.split(/\r?\n/)) {
          const row = line.trim();
          const match =
            /^\|\s*\[[^\]]+\]\(https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\)\s*\|/.exec(
              row
            );
          if (!match) continue;
          const key = `${match[1].toLowerCase()}#${Number(match[2])}`;
          boardRows.set(
            key,
            boardRows.has(key)
              ? null
              : createHash('sha256').update(row).digest('hex')
          );
        }
      }
    } catch {
      // A failed readback leaves the corresponding board entry pending.
    }
  }
  signal?.throwIfAborted();
  return {
    facts,
    boardRows,
    fingerprint: sha(facts),
    requiresAgent,
    counts: { issues: issues.length, prs: heads.length, hosts: hosts.length },
    checkedTracked: scope.tracked,
    terminalReviews: audited,
  };
}

function reconcileBoardReviews(scope, record, snapshot, acknowledged, now) {
  const boardPrs = new Set(
    scope?.boardPrs ??
      scope?.tracked?.map(({ repository, number }) => `${repository}#${number}`)
  );
  const pending = { ...record.boardPending };
  // A PR that left the board has no row left to publish or hold (only an
  // explicit board list is authoritative).
  if (Array.isArray(scope?.boardPrs))
    for (const key of Object.keys(pending))
      if (!boardPrs.has(key)) delete pending[key];
  const reviews = {};
  const resolutions = new Map(
    (Array.isArray(scope?.boardResolutions) ? scope.boardResolutions : [])
      .filter(
        (row) =>
          row && (boardPrs.has(row.key) || Object.hasOwn(pending, row.key))
      )
      .map((row) => [row.key, row])
  );
  for (const {
    key,
    aliases = [],
    head,
    state,
    reviewEvents,
    awaitingReview,
  } of snapshot.facts?.heads || []) {
    const keys = [key, ...aliases].filter(
      (key) => boardPrs.has(key) || Object.hasOwn(pending, key)
    );
    if (!keys.length) continue;
    const decisions = reviewEvents.filter(
      ({ head: reviewedHead, at, state }) =>
        reviewedHead === head &&
        Number.isFinite(Date.parse(at)) &&
        BOARD_DECISION_STATES.has(state)
    );
    // Awaiting review from you again (same head) makes the row due; the
    // unrequested fingerprint is unchanged so existing rows stay settled.
    const fingerprint = sha(
      awaitingReview ? [head, decisions, 'awaiting-review'] : [head, decisions]
    );
    for (const key of keys) {
      const previous = record.boardReviews?.[key];
      reviews[key] = { head, fingerprint };
      if (
        (pending[key] && pending[key].fingerprint !== fingerprint) ||
        (!previous && state === 'open' && decisions.length > 0) ||
        (previous &&
          previous.fingerprint !== fingerprint &&
          (previous.head === head ||
            (state === 'open' && decisions.length > 0)))
      ) {
        pending[key] = {
          key,
          head,
          fingerprint,
          detectedAt: new Date(now).toISOString(),
        };
      }
    }
  }
  for (const [key, item] of Object.entries(pending)) {
    const resolution = resolutions.get(key);
    if (
      resolution?.fingerprint !== item.fingerprint ||
      !(
        acknowledged >= Date.parse(item.detectedAt) &&
        acknowledged <= now &&
        now - acknowledged < 2 * 60 * 60 * 1000
      )
    )
      continue;
    if (
      resolution.disposition === 'published' &&
      /^[0-9a-f]{64}$/.test(resolution.rowSha256) &&
      snapshot.boardRows?.get(key) === resolution.rowSha256
    ) {
      delete pending[key];
    } else if (
      resolution.disposition === 'hold' &&
      typeof resolution.reason === 'string' &&
      resolution.reason.trim() &&
      typeof resolution.owner === 'string' &&
      resolution.owner.trim() &&
      typeof resolution.recheckAt === 'string' &&
      Date.parse(resolution.recheckAt) > now
    ) {
      pending[key] = {
        ...item,
        hold: {
          reason: resolution.reason,
          owner: resolution.owner,
          recheckAt: resolution.recheckAt,
        },
      };
    }
  }
  record.boardReviews = reviews;
  record.boardPending = pending;
  return Object.values(pending).filter(
    (item) => !(Date.parse(item.hold?.recheckAt) > now)
  );
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
  const snapshot = await collect(record.terminalReviews);
  const checked = now();
  const at = new Date(checked).toISOString();
  const acknowledged = Date.parse(acknowledgedAt);
  const pendingAt = Date.parse(record.pending?.at);
  const boardPending = reconcileBoardReviews(
    scope,
    record,
    snapshot,
    acknowledged,
    checked
  );
  if (
    boardPending.length === 0 &&
    record.pending?.fingerprint === snapshot.fingerprint &&
    Number.isFinite(acknowledged) &&
    acknowledged >= pendingAt &&
    acknowledged <= checked &&
    checked - acknowledged < 2 * 60 * 60 * 1000
  )
    record.baseline = { fingerprint: snapshot.fingerprint, at: acknowledgedAt };
  const factsUnchanged =
    snapshot.requiresAgent !== true &&
    record.baseline?.fingerprint === snapshot.fingerprint;
  const changed = boardPending.length > 0 || !factsUnchanged;
  record.pending = {
    at:
      record.pending?.fingerprint === snapshot.fingerprint
        ? record.pending.at
        : at,
    fingerprint: snapshot.fingerprint,
    counts: snapshot.counts,
  };
  if (snapshot.terminalReviews)
    record.terminalReviews = snapshot.terminalReviews;
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
    boardPending,
    factsUnchanged,
    counts: snapshot.counts,
    fingerprint: snapshot.fingerprint,
    coverage: snapshot.facts?.coverage,
    registryHash: snapshot.facts?.registryHash,
    checkedTracked: snapshot.checkedTracked,
  };
}
