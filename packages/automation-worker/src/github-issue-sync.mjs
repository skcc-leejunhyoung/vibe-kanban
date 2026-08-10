const MARKER_PREFIX = '<!-- vibe-kanban-issue:';

export function githubIssueMarker(issueId) {
  return `${MARKER_PREFIX}${issueId} -->`;
}

export function normalizeOptionalTimestamp(...candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const timestamp = Date.parse(String(candidate));
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return null;
}

export function decideGithubParentSync({
  baselineParentIssueId,
  vibeParentIssueId,
  githubParentIssueId,
  vibeUpdatedAt,
  githubUpdatedAt,
}) {
  const baseline = baselineParentIssueId || null;
  const vibeParent = vibeParentIssueId || null;
  const githubParent = githubParentIssueId || null;
  if (vibeParent === githubParent) {
    return { direction: 'none', parentIssueId: vibeParent };
  }

  const vibeChanged = vibeParent !== baseline;
  const githubChanged = githubParent !== baseline;
  if (vibeChanged && !githubChanged) {
    return { direction: 'to_github', parentIssueId: vibeParent };
  }
  if (githubChanged && !vibeChanged) {
    return { direction: 'to_vibe', parentIssueId: githubParent };
  }
  if (!vibeChanged && !githubChanged) {
    return { direction: 'none', parentIssueId: baseline };
  }

  const githubTime = Date.parse(githubUpdatedAt || '');
  const vibeTime = Date.parse(vibeUpdatedAt || '');
  if (
    Number.isFinite(githubTime) &&
    (!Number.isFinite(vibeTime) || githubTime >= vibeTime)
  ) {
    return { direction: 'to_vibe', parentIssueId: githubParent };
  }
  return { direction: 'to_github', parentIssueId: vibeParent };
}

export function decideGithubMilestoneSync({
  baselineMilestoneId,
  baselineGithubNumber,
  vibeMilestoneId,
  githubMilestoneNumber,
  assignmentsMatch = false,
  vibeUpdatedAt,
  githubUpdatedAt,
}) {
  const baselineVibe = baselineMilestoneId || null;
  const baselineGithub = baselineGithubNumber ?? null;
  const vibe = vibeMilestoneId || null;
  const github = githubMilestoneNumber ?? null;
  if (
    assignmentsMatch ||
    (vibe === baselineVibe && github === baselineGithub)
  ) {
    return { direction: 'none' };
  }
  const vibeChanged = vibe !== baselineVibe;
  const githubChanged = github !== baselineGithub;
  if (vibeChanged && !githubChanged) return { direction: 'to_github' };
  if (githubChanged && !vibeChanged) return { direction: 'to_vibe' };
  if (!vibeChanged && !githubChanged) return { direction: 'none' };
  const githubTime = Date.parse(githubUpdatedAt || '');
  const vibeTime = Date.parse(vibeUpdatedAt || '');
  return Number.isFinite(githubTime) &&
    (!Number.isFinite(vibeTime) || githubTime >= vibeTime)
    ? { direction: 'to_vibe' }
    : { direction: 'to_github' };
}

// Deduplicate a poll's fetched issues into a candidate list, advancing the
// high-water cursor over every fetched item.
//
// The same GitHub issue can arrive from two sources with *different* identity
// keys: the REST assigned-issues poll exposes `issue.id` as the numeric REST id,
// while Project V2 items (loadGithubProjectIssues) expose `issue.id` as the
// GraphQL node id. `seen` (persisted as `seenIds`) is keyed by `issue.id`, so a
// project item imported under its node id would not be recognized when the same
// issue later reappears via REST under its numeric id — creating a duplicate
// Vibe issue. `seenNumbers` closes that gap: for repo-local issues (a connector
// polls a single repo, where issue/PR numbers are unique) it dedups by
// `issue.number`, which both sources agree on. Review PRs are excluded because
// they can come from other repos where numbers collide. `seenNumbers` is
// additive — it never relaxes the legacy `seen` check — so existing persisted
// `seenIds` keep working across the upgrade, and skipping a project item via the
// legacy `seen` set still records its number so the REST twin is caught.
export function selectGithubPollCandidates({
  items,
  seen,
  seenNumbers,
  includePullRequests = false,
  latest = '',
}) {
  const candidates = [];
  const batchIds = new Set();
  let cursor = latest;
  for (const issue of Array.isArray(items) ? items : []) {
    if (issue.updated_at && issue.updated_at > cursor)
      cursor = issue.updated_at;
    // PRs from the assigned-issue query are dropped unless includePullRequests;
    // PRs surfaced by the review-requested search are always kept.
    if (issue.pull_request && !issue.__reviewPr && !includePullRequests)
      continue;
    const seenKey = String(issue.id);
    // Review PRs can come from other repos where numbers collide, so dedup them
    // within the batch by identity (id), not number — mirroring how they are
    // excluded from the cross-poll `seenNumbers` set below.
    const batchKey = issue.__reviewPr ? String(issue.id) : String(issue.number);
    const numberKey = issue.__reviewPr ? null : String(issue.number);
    if (
      seen.has(seenKey) ||
      (numberKey && seenNumbers.has(numberKey)) ||
      batchIds.has(batchKey)
    ) {
      if (numberKey) seenNumbers.add(numberKey);
      continue;
    }
    batchIds.add(batchKey);
    candidates.push(issue);
  }
  return { candidates, latest: cursor };
}

// The first poll only seeds the dedup sets so enabling a connector never floods
// the board with an existing backlog. Project items are no exception: exempting
// them made seeding import the entire board — the one moment the guard matters
// most. Set `backfill:true` to import the backlog deliberately instead.
export function selectGithubImportCandidates({ candidates, seeding }) {
  const items = Array.isArray(candidates) ? candidates : [];
  if (!seeding) return { importCandidates: items, seedOnly: [] };
  return { importCandidates: [], seedOnly: items };
}

// Resolve which side of a project Status wins. A link that has never synced
// (`syncedVibeStatusId == null`) adopts whatever GitHub already shows — pushing
// the Vibe import column instead would overwrite the board for every imported
// issue at once. Established links keep the existing last-writer precedence.
export function decideGithubProjectStatusSync({
  statusMappings = [],
  vibeStatusId,
  syncedVibeStatusId = null,
  githubOptionId = null,
  syncedGithubOptionId = null,
}) {
  const mappings = Array.isArray(statusMappings) ? statusMappings : [];
  const vibeMapping = mappings.find((m) => m.vibeStatusId === vibeStatusId);
  const githubMapping = mappings.find(
    (m) => m.githubOptionId === githubOptionId
  );
  const unchanged = { action: 'none', vibeStatusId, githubOptionId };

  if (syncedVibeStatusId == null) {
    // Never overwrite a status the board already carries, mapped or not.
    if (githubOptionId) {
      return githubMapping
        ? {
            action: 'adopt',
            vibeStatusId: githubMapping.vibeStatusId,
            githubOptionId,
          }
        : unchanged;
    }
    return vibeMapping
      ? {
          action: 'push',
          vibeStatusId,
          githubOptionId: vibeMapping.githubOptionId,
        }
      : unchanged;
  }

  if (vibeMapping && vibeStatusId !== syncedVibeStatusId) {
    return {
      action: 'push',
      vibeStatusId,
      githubOptionId: vibeMapping.githubOptionId,
    };
  }
  if (githubMapping && githubOptionId !== syncedGithubOptionId) {
    return {
      action: 'adopt',
      vibeStatusId: githubMapping.vibeStatusId,
      githubOptionId,
    };
  }
  return unchanged;
}

// Mark an imported/seeded issue in both dedup sets so subsequent polls skip it
// regardless of which source (REST id vs GraphQL node id) surfaces it next.
export function markGithubIssueSeen(issue, seen, seenNumbers) {
  seen.add(String(issue.id));
  if (!issue.__reviewPr) seenNumbers.add(String(issue.number));
}

// GitHub normalizes a milestone's `due_on` to a fixed time-of-day (e.g. 08:00Z)
// while Vibe stores user-picked dates at 00:00Z and Postgres may render its own
// offset, so a raw ISO string compare treats the same calendar day as different
// and drives a redundant milestone PATCH on GitHub *and* Vibe every reconcile.
// Milestones are day-granular, so compare only the date portion.
function sameMilestoneDay(a, b) {
  const da = a ? String(a).slice(0, 10) : null;
  const db = b ? String(b).slice(0, 10) : null;
  return da === db;
}

export function githubMilestoneMetaDiffers(vibeMilestone, githubMilestone) {
  return (
    vibeMilestone.name !== githubMilestone.title ||
    !sameMilestoneDay(vibeMilestone.target_date, githubMilestone.due_on) ||
    Boolean(vibeMilestone.completed_at) !== (githubMilestone.state === 'closed')
  );
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

// --- Bidirectional comment sync ---------------------------------------------
//
// A comment's identity link lives on the vibe row (issue_comments.github_comment_id).
// That id mapping alone prevents echo on the normal path; the marker below is a
// repair backstop for the one gap the id can't cover: a vibe comment pushed to
// GitHub whose id-store failed before it landed. On the next poll the pushed
// GitHub comment still carries the marker, so import repairs the mapping instead
// of creating a duplicate. Mirrors withGithubIssueMarker for issues.
const COMMENT_MARKER_PREFIX = '<!-- vibe-kanban-comment:';

export function commentMarker(commentId) {
  return `${COMMENT_MARKER_PREFIX}${commentId} -->`;
}

export function withCommentMarker(message, commentId) {
  const marker = commentMarker(commentId);
  const text = message == null ? '' : String(message);
  if (text.includes(marker)) return text;
  return text ? `${text}\n\n${marker}` : marker;
}

export function withoutCommentMarker(body) {
  if (body == null) return '';
  return String(body)
    .replace(/(?:\r?\n){0,2}<!-- vibe-kanban-comment:[^>]+ -->/g, '')
    .trimEnd();
}

export function commentMarkerId(body) {
  const match = String(body == null ? '' : body).match(
    /<!-- vibe-kanban-comment:([^\s>]+) -->/
  );
  return match ? match[1] : null;
}

// Content-equality first (so a synced pair never churns), then last-writer-wins
// by updated_at — same shape as the issue title/description reconcile.
export function decideCommentSync({
  githubMessage,
  vibeMessage,
  githubUpdatedAt,
  vibeUpdatedAt,
}) {
  if (githubMessage === vibeMessage) return { direction: 'none' };
  const githubTime = Date.parse(githubUpdatedAt || '');
  const vibeTime = Date.parse(vibeUpdatedAt || '');
  if (
    Number.isFinite(githubTime) &&
    (!Number.isFinite(vibeTime) || githubTime >= vibeTime)
  ) {
    return { direction: 'to_vibe' };
  }
  return { direction: 'to_github' };
}

// Decide, for one mapped issue, which comments to import (github→vibe), push
// (vibe→github), edit-reconcile, or repair-map. The caller passes only comments
// belonging to the mapped issue on each side, so the 1:1 link is already the
// scope boundary. `cutoff` (link.comments_synced_after) gates the PUSH direction
// only: a native vibe comment created at/before it is never published to GitHub,
// so enabling sync never back-posts internal history. IMPORT is deliberately not
// gated — the issue's existing GitHub discussion is pulled in so it is visible.
export function planCommentSync({ githubComments, vibeComments, cutoff }) {
  const imports = [];
  const pushes = [];
  const edits = [];
  const repairs = [];

  const gh = Array.isArray(githubComments) ? githubComments : [];
  const vibe = Array.isArray(vibeComments) ? vibeComments : [];
  const cut = cutoff ? Date.parse(cutoff) : null;
  const afterCutoff = (iso) => {
    if (cut == null || !Number.isFinite(cut)) return false;
    const t = Date.parse(iso || '');
    return Number.isFinite(t) && t > cut;
  };

  const vibeByGithubId = new Map();
  const vibeById = new Map();
  for (const c of vibe) {
    vibeById.set(String(c.id), c);
    if (c.github_comment_id != null) {
      vibeByGithubId.set(String(c.github_comment_id), c);
    }
  }

  const repairedVibeIds = new Set();
  for (const gc of gh) {
    const gid = String(gc.id);
    const stripped = withoutCommentMarker(gc.body);
    const mapped = vibeByGithubId.get(gid);
    if (mapped) {
      const decision = decideCommentSync({
        githubMessage: stripped,
        vibeMessage: mapped.message,
        githubUpdatedAt: gc.updated_at,
        vibeUpdatedAt: mapped.updated_at,
      });
      if (decision.direction === 'to_vibe') {
        edits.push({ direction: 'to_vibe', vibe: mapped, message: stripped });
      } else if (decision.direction === 'to_github') {
        edits.push({ direction: 'to_github', vibe: mapped, github: gc });
      }
      continue;
    }
    // Unmapped: if it carries our marker it is a vibe comment we already pushed
    // whose id-store didn't land — repair the mapping, never duplicate.
    const markerId = commentMarkerId(gc.body);
    if (markerId && vibeById.has(String(markerId))) {
      repairs.push({ vibeCommentId: String(markerId), githubCommentId: gid });
      repairedVibeIds.add(String(markerId));
      continue;
    }
    // Genuinely new GitHub comment: import it. Not cutoff-gated — existing
    // GitHub discussion must be visible in vibe, not just comments going forward.
    imports.push(gc);
  }

  for (const vc of vibe) {
    if (vc.github_comment_id != null) continue; // already mirrored
    if (vc.github_author_login != null) continue; // came from github (never echo back)
    if (repairedVibeIds.has(String(vc.id))) continue; // mapped this round
    if (!afterCutoff(vc.created_at)) continue; // pre-cutoff native history stays put
    pushes.push(vc);
  }

  return { imports, pushes, edits, repairs };
}

export function shouldSyncGithubProjectStatus(config) {
  return config?.fields?.status !== false;
}

export function assertGithubIssueProject(issue, expectedProjectId) {
  if (!issue || issue.project_id !== expectedProjectId) {
    throw new Error('Vibe issue does not belong to the configured project');
  }
}

export function shouldRunGithubIssueSyncRule(rule, event) {
  return (
    rule?.kind !== 'github_issue_sync' ||
    rule.config?.githubConnectorId === event?.connectorId
  );
}

export function githubIssueSyncVibeConnectorId(rule, requestedConnectorId) {
  if (rule?.kind !== 'github_issue_sync') return requestedConnectorId;
  return String(rule.config?.vibeConnectorId || requestedConnectorId || '');
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

/**
 * Re-attempt due pending github_issue_link operations.
 *
 * This queue used to retry every op on every poll forever with no attempt
 * counter, no backoff, and no way out: `onFailure` only logged. An op whose
 * Vibe issue had been deleted could never succeed, so it hammered the API each
 * cycle and stayed in `state.json` permanently — a runaway import left 2157 of
 * them behind, bloating the file to 13 MB. The policy now matches the sibling
 * PR-link queue in pull-request-links.mjs (whose header already claimed to
 * mirror this one): backoff between attempts, then drop as exhausted.
 *
 * Like the sibling's `resolveConnector`, an optional `isAvailable(operation)`
 * lets the caller carry an op forward *without* spending an attempt while its
 * rule / connector is temporarily gone or disabled — otherwise a rule toggled
 * off for a few minutes would burn all attempts and drop a still-valid link,
 * re-introducing the orphaning this queue exists to prevent.
 *
 * @returns {Promise<{remaining: Array<object>, recovered: number, changed: boolean}>}
 *   `remaining` replaces the caller's queue; `changed` is false when nothing
 *   was attempted, so the caller can skip persisting.
 */
export async function retryPendingGithubIssueLinkOperations({
  operations,
  connectorId,
  linkIssue,
  isAvailable,
  onFailure,
  onExhausted,
  now,
  retryDelay,
  maxAttempts,
}) {
  const remaining = [];
  let recovered = 0;
  let changed = false;

  for (const operation of operations) {
    // Other connectors' ops are carried forward untouched.
    if (operation.githubConnectorId !== connectorId) {
      remaining.push(operation);
      continue;
    }
    // Respect backoff: not-due items are carried forward without an attempt.
    if (operation.nextAttemptAt && operation.nextAttemptAt > now) {
      remaining.push(operation);
      continue;
    }
    // Can't link while the rule/connector is gone or disabled — keep the op
    // without spending an attempt so it recovers once the target returns
    // (mirrors resolveConnector in pull-request-links.mjs).
    if (isAvailable && !isAvailable(operation)) {
      remaining.push(operation);
      continue;
    }

    try {
      await linkIssue(operation.input);
      recovered += 1;
      changed = true;
    } catch (error) {
      changed = true;
      operation.attempts = (operation.attempts || 0) + 1;
      operation.updatedAt = now;
      operation.lastError =
        error && error.message ? error.message : String(error);
      const cap = operation.maxAttempts || maxAttempts;
      if (operation.attempts >= cap) {
        // Give up. The issue can still be linked by hand from the issue panel.
        if (onExhausted) await onExhausted(operation, error);
      } else {
        operation.nextAttemptAt = now + retryDelay(operation.attempts);
        remaining.push(operation);
        if (onFailure) await onFailure(operation, error);
      }
    }
  }

  return { remaining, recovered, changed };
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
