import { createHash } from 'node:crypto';

const sha = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = (rows) =>
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sha1 = /^[0-9a-f]{40}$/i;
const SOURCE_READ_CONCURRENCY = 8;
const PR_BATCH_SIZE = 40;
const PR_METADATA = 'number fullDatabaseId headRefOid state isDraft updatedAt';
const BOARD_DECISION_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'DISMISSED',
]);

// The account's REST budget is shared with `gh` and every other automation;
// reconciliation never spends the last `reserve` calls.
export class GithubBudgetLow extends Error {
  constructor(remaining, reserve, reset) {
    super('GitHub rate budget below reserve');
    this.remaining = remaining;
    this.reserve = reserve;
    if (Number.isSafeInteger(reset) && reset > 0) this.retryAt = reset;
  }
}

export function checkGithubBudget(remaining, reserve, reset) {
  if (Number.isFinite(remaining) && remaining < reserve)
    throw new GithubBudgetLow(remaining, reserve, reset);
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

function repositoryQuery(repository) {
  const [owner, name] = repository.split('/');
  return `repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)})`;
}

async function readPrMetadata(refs, graphql, reads, signal) {
  const result = new Map();
  for (let start = 0; start < refs.length; start += PR_BATCH_SIZE) {
    signal?.throwIfAborted();
    const batch = refs.slice(start, start + PR_BATCH_SIZE);
    const query = batch
      .map(
        ({ repository, number }, i) =>
          `p${i}: ${repositoryQuery(repository)} { pullRequest(number: ${number}) { ${PR_METADATA} } }`
      )
      .join(' ');
    reads.metadataBatches++;
    const data = await graphql(`query ReconciliationPullRequests { ${query} }`);
    for (const [i, ref] of batch.entries()) {
      const node = data?.[`p${i}`]?.pullRequest;
      if (
        node?.number !== ref.number ||
        !['OPEN', 'CLOSED', 'MERGED'].includes(node?.state) ||
        typeof node.isDraft !== 'boolean'
      )
        throw new Error('incomplete PR metadata batch');
      if (
        typeof node.fullDatabaseId !== 'number' &&
        !/^\d+$/.test(node.fullDatabaseId || '')
      )
        throw new Error('invalid PR database ID');
      if (
        !Number.isSafeInteger(Number(node.fullDatabaseId)) ||
        Number(node.fullDatabaseId) < 1 ||
        !sha1.test(node.headRefOid || '') ||
        typeof node.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(node.updatedAt))
      )
        throw new Error('incomplete PR metadata batch');
      const before = {
        id: Number(node.fullDatabaseId),
        head: { sha: node.headRefOid },
        state: node.state === 'OPEN' ? 'open' : 'closed',
        merged: node.state === 'MERGED',
        draft: node.isDraft,
        updated_at: node.updatedAt,
      };
      result.set(`${ref.repository}#${ref.number}`, {
        before,
        version: prVersion(before),
      });
    }
  }
  return result;
}

async function openPrNumbers(repository, graphql, reads, signal) {
  const numbers = new Set();
  let after = null;
  let total;
  const cursors = new Set();
  for (;;) {
    signal?.throwIfAborted();
    reads.openListPages++;
    const data = await graphql(`query ReconciliationOpenPullRequests {
      ${repositoryQuery(repository)} {
        pullRequests(states: OPEN, first: 100, after: ${JSON.stringify(after)}, orderBy: {field: CREATED_AT, direction: ASC}) {
          totalCount nodes { number } pageInfo { hasNextPage endCursor }
        }
      }
    }`);
    const page = data?.repository?.pullRequests;
    if (
      !Array.isArray(page?.nodes) ||
      !Number.isSafeInteger(page.totalCount) ||
      page.totalCount < 0 ||
      (total !== undefined && total !== page.totalCount) ||
      page.nodes.length !== Math.min(100, page.totalCount - numbers.size) ||
      typeof page.pageInfo?.hasNextPage !== 'boolean' ||
      page.pageInfo.hasNextPage !==
        numbers.size + page.nodes.length < page.totalCount
    )
      throw new Error('incomplete open PR inventory');
    total = page.totalCount;
    for (const node of page.nodes) {
      if (
        !Number.isSafeInteger(node?.number) ||
        node.number < 1 ||
        numbers.has(node.number)
      )
        throw new Error('invalid open PR inventory');
      numbers.add(node.number);
    }
    if (!page.pageInfo.hasNextPage) return numbers;
    after = page.pageInfo.endCursor;
    if (typeof after !== 'string' || !after || cursors.has(after))
      throw new Error('invalid open PR cursor');
    cursors.add(after);
  }
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
  if (
    scope.acknowledgedFingerprint !== undefined &&
    (typeof scope.acknowledgedFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(scope.acknowledgedFingerprint))
  )
    throw new Error('invalid acknowledged fingerprint');
  if (scope.registryIndex !== undefined) {
    const { byPr, unscoped } = scope.registryIndex || {};
    const digest = /^[0-9a-f]{64}$/;
    if (typeof unscoped !== 'string' || !digest.test(unscoped) || !byPr || typeof byPr !== 'object' ||
        Array.isArray(byPr) || Object.keys(byPr).length > 2000 ||
        Object.entries(byPr).some(([key, value]) =>
          !/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(key) || typeof value !== 'string' || !digest.test(value)))
      throw new Error('invalid registry index');
  }
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
  graphql,
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
  const githubReads = {
    metadataBatches: 0,
    openListPages: 0,
    reviewPages: 0,
    reusedTerminal: 0,
  };
  const refs = [...prs].sort(([a], [b]) => a.localeCompare(b));
  const terminalByRef = new Map();
  for (const entry of Object.values(terminalReviews)) {
    const facts = entry?.facts;
    if (
      facts?.state !== 'closed' ||
      !Number.isSafeInteger(facts.id) ||
      !sha1.test(facts.head) ||
      !entry.version ||
      !Array.isArray(facts.reviewEvents) ||
      !Array.isArray(facts.reviews)
    )
      continue;
    for (const key of [facts.key, ...(facts.aliases || [])])
      terminalByRef.set(key, entry);
  }
  // Merged PRs cannot reopen. Closed PRs can, so check the open list once per
  // repository instead of polling each closed PR and its reviews.
  const reopenRepositories = new Set(
    refs
      .filter(([key]) => {
        const cached = terminalByRef.get(key);
        return cached && !cached.merged && !awaiting.has(key);
      })
      .map(([, ref]) => ref.repository)
  );
  const openByRepo = new Map(
    await readBatches(
      [...reopenRepositories],
      async (repo) => [
        repo,
        await openPrNumbers(repo, graphql, githubReads, signal),
      ],
      signal
    )
  );
  const needsMetadata = ([key, ref]) => {
    const cached = terminalByRef.get(key);
    return (
      !cached ||
      (!cached.merged &&
        (awaiting.has(key) || openByRepo.get(ref.repository)?.has(ref.number)))
    );
  };
  const metadata = await readPrMetadata(
    refs.filter(needsMetadata).map(([, ref]) => ref),
    graphql,
    githubReads,
    signal
  );

  const identities = new Map();
  for (const [key, ref] of refs) {
    const observed = metadata.get(key);
    const cached = terminalByRef.get(key);
    const id = observed?.before.id ?? cached.facts.id;
    const existing = identities.get(id);
    if (!existing) {
      identities.set(id, { key, aliases: [], observed, cached, ref });
      continue;
    }
    if (
      observed &&
      existing.observed &&
      (observed.version !== existing.observed.version ||
        observed.before.merged !== existing.observed.before.merged)
    )
      throw new Error('PR changed during alias resolution');
    existing.aliases.push(key);
    if (observed && !existing.observed)
      Object.assign(existing, { observed, ref });
    if (cached && !existing.cached) existing.cached = cached;
  }

  const terminal = {};
  const verifyOpen = [];
  const heads = await readBatches(
    [...identities.values()],
    async ({ key, aliases, observed, cached, ref }) => {
      const { before, version } = observed || {};
      if (
        !observed ||
        (before.state === 'closed' && cached?.version === version)
      ) {
        githubReads.reusedTerminal++;
        // Strip updated_at from compatibility snapshots before comparing facts.
        const { updated_at: _, ...saved } = cached.facts;
        const facts = { ...saved, key, aliases, awaitingReview: false };
        terminal[facts.id] = {
          version: cached.version,
          merged: before?.merged ?? cached.merged,
          facts,
        };
        return facts;
      }

      const awaitingReview =
        before.state === 'open' &&
        [key, ...aliases].some((ref) => awaiting.has(ref));
      const reviews = [];
      for (let page = 1; before.state === 'open'; page++) {
        signal?.throwIfAborted();
        githubReads.reviewPages++;
        const rows = await github(
          `/repos/${ref.repository}/pulls/${ref.number}/reviews?per_page=100&page=${page}`
        );
        if (!Array.isArray(rows)) throw new Error('incomplete reviews');
        reviews.push(...rows);
        if (rows.length < 100) break;
        if (page >= 1000) throw new Error('review pagination limit');
      }
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
        terminal[before.id] = { version, merged: before.merged, facts };
      else verifyOpen.push({ ref, version });
      return facts;
    },
    signal
  );
  const after = await readPrMetadata(
    verifyOpen.map(({ ref }) => ref),
    graphql,
    githubReads,
    signal
  );
  for (const { ref, version } of verifyOpen) {
    if (after.get(`${ref.repository}#${ref.number}`)?.version !== version)
      throw new Error('PR changed during reconciliation');
  }
  const hosts = [];
  const dueResumes = [];
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
          if (due <= now())
            dueResumes.push({ ...resume, machineId, workspaceId: workspace.id, sessionId: session.id });
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
    requiresAgent: dueResumes.length > 0,
    dueResumes,
    counts: { issues: issues.length, prs: heads.length, hosts: hosts.length },
    checkedTracked: scope.tracked,
    terminalReviews: terminal,
    githubReads,
  };
}

function indexFacts(facts) {
  if (!facts?.heads || !facts.issues || !facts.hosts) return;
  const sessions = [];
  const workspaces = [];
  for (const { machineId, workspaces: rows } of facts.hosts) {
    for (const { id: workspaceId, sessions: local, ...workspace } of rows) {
      workspaces.push([JSON.stringify([machineId, workspaceId]), { machineId, workspaceId, ...workspace }]);
      for (const session of local) {
        const key = JSON.stringify([machineId, workspaceId, session.id]);
        sessions.push([key, { machineId, workspaceId, ...session }]);
      }
    }
  }
  return {
    scope: sha([facts.coverage, facts.boardNoteId, facts.boardPrs]),
    registryHash: facts.registryHash,
    workspaces: Object.fromEntries(workspaces),
    prs: Object.fromEntries(facts.heads.map((pr) => [pr.id, {
      key: pr.key,
      aliases: pr.aliases,
      head: pr.head,
      state: pr.state,
      draft: pr.draft,
      awaitingReview: pr.awaitingReview,
      version: sha(pr),
    }])),
    issues: Object.fromEntries(facts.issues.map((issue) => [issue.id, issue])),
    sessions: Object.fromEntries(sessions),
  };
}

function changedRows(kind, previous, current) {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .sort()
    .flatMap((key) => {
      const before = previous[key] ?? null;
      const after = current[key] ?? null;
      if (sha(before) === sha(after)) return [];
      return [{ kind, key, before, after, version: sha([kind, key, before, after]) }];
    });
}

function reconciliationChanges(baseline, index, snapshot) {
  const previous = baseline?.index;
  if (!previous?.workspaces || typeof previous.workspaces !== 'object' || !index) return;
  const registryChanged = previous.registryHash !== index.registryHash;
  const registryScoped = previous.registry && index.registry &&
    previous.registry.unscoped === index.registry.unscoped;
  const registryChecks = registryChanged && registryScoped
    ? changedRows('registry', previous.registry.byPr, index.registry.byPr) : [];
  const checks = [
    ...changedRows('pr', previous.prs, index.prs),
    ...changedRows('issue', previous.issues, index.issues),
    ...changedRows('workspace', previous.workspaces, index.workspaces),
    ...changedRows('session', previous.sessions, index.sessions),
    ...registryChecks,
  ];
  for (const resume of snapshot.dueResumes || []) {
    checks.push({ kind: 'resume', key: resume.id, after: resume, version: sha(['resume', resume]) });
  }
  const refs = new Set();
  for (const { kind, before, after } of checks) {
    if (kind === 'pr') {
      for (const row of [before, after]) {
        if (row) for (const ref of [row.key, ...row.aliases]) refs.add(ref);
      }
    } else if (kind === 'issue') {
      for (const url of [...(before?.prs || []), ...(after?.prs || [])])
        refs.add(url.toLowerCase().replace('https://github.com/', '').replace('/pull/', '#'));
    }
  }
  for (const { key } of registryChecks) refs.add(key);
  const board = new Set(snapshot.facts.boardPrs);
  const boardHeads = {};
  const prFacts = {};
  for (const pr of snapshot.facts.heads) {
    for (const key of [pr.key, ...pr.aliases]) {
      if (board.has(key)) boardHeads[key] = pr.head;
      if (refs.has(key) || board.has(key)) {
        const { reviewEvents, ...decisions } = pr;
        prFacts[key] = decisions;
      }
    }
  }
  return {
    baseFingerprint: baseline.fingerprint,
    baseAcknowledgedAt: baseline.at,
    scopeChanged: previous.scope !== index.scope,
    registryChanged: registryChanged && registryChecks.length === 0,
    checks,
    prFacts,
    boardHeads,
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
      const item = pending[key];
      const lastKnown = item ?? previous;
      // An empty terminal snapshot may have skipped the review lookup. Keep
      // the last review evidence and its hold until there is a new head or review.
      if (
        state === 'closed' &&
        reviewEvents.length === 0 &&
        lastKnown?.head === head
      ) {
        reviews[key] = { head, fingerprint: lastKnown.fingerprint, state };
        continue;
      }
      reviews[key] = { head, fingerprint, state };
      if (
        (item && item.fingerprint !== fingerprint) ||
        (previous?.state === 'closed' && state === 'open' && awaitingReview) ||
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
  const bound = scope?.acknowledgedFingerprint;
  const acknowledged = bound && (
    bound !== snapshot.fingerprint || bound !== record.pending?.fingerprint
  ) ? NaN : Date.parse(acknowledgedAt);
  const pendingAt = Date.parse(record.pending?.at);
  const index = indexFacts(snapshot.facts);
  if (index && scope?.registryIndex) index.registry = scope.registryIndex;
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
    record.baseline = { fingerprint: snapshot.fingerprint, at: acknowledgedAt, index };
  // Older worker state only has a hash. Index it once the exact facts are seen again.
  if (record.baseline?.fingerprint === snapshot.fingerprint)
    record.baseline.index = index;
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
    githubReads: snapshot.githubReads,
    changes: changed ? reconciliationChanges(record.baseline, index, snapshot) : undefined,
  };
}
