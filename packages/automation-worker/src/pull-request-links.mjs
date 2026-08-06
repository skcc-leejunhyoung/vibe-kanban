// Retry queue for structural PR→issue links (`pull_request_issues`).
//
// When the automation worker creates a `review`-tagged issue from a GitHub PR it
// makes a best-effort `POST /v1/pull_request_issues` so the issue carries a
// structural PR link (Vibe's review mode only activates on that join row; a URL
// in the description body is ignored). That POST used to be fire-and-forget: a
// transient failure was only logged, the PR id was already recorded in `seen`,
// so the worker never revisited the PR and the issue kept its `review` tag but
// never got its link — surfacing as "No open PR found for this issue".
//
// This mirrors the `github_issue_links` recovery path: failed links are queued
// and re-attempted on the next poll with exponential backoff, then dropped after
// `maxAttempts` so a permanently failing link (e.g. a deleted issue) can't retry
// forever. This is a pure function — the caller injects all side effects
// (connector lookup, the actual POST, logging) so it can be unit-tested.

/**
 * Re-attempt due pending PR-link operations.
 *
 * @param {object} args
 * @param {Array<object>} args.operations Pending ops (mutated in place on retry).
 * @param {number} args.now Current epoch ms (injected so tests are deterministic).
 * @param {(vibeConnectorId: string) => (object|null)} args.resolveConnector
 *   Returns the enabled Vibe connector for the op, or null when it is missing or
 *   disabled (the op is then kept without spending an attempt).
 * @param {(connector: object, payload: object) => Promise<void>} args.linkPr
 *   Performs the link POST; must throw on failure.
 * @param {(attempts: number) => number} args.retryDelay Backoff in ms per attempt.
 * @param {number} args.maxAttempts Cap before an op is dropped as exhausted.
 * @param {(op: object) => (void|Promise<void>)} [args.onRecovered]
 * @param {(op: object, error: unknown) => (void|Promise<void>)} [args.onFailed]
 * @param {(op: object, error: unknown) => (void|Promise<void>)} [args.onExhausted]
 * @returns {Promise<{remaining: Array<object>, recovered: number, changed: boolean}>}
 */
export async function retryPendingPullRequestLinkOperations({
  operations,
  now,
  resolveConnector,
  linkPr,
  retryDelay,
  maxAttempts,
  onRecovered,
  onFailed,
  onExhausted,
}) {
  const remaining = [];
  let recovered = 0;
  let changed = false;

  for (const op of operations) {
    // Respect backoff: not-due items are carried forward untouched.
    if (op.nextAttemptAt && op.nextAttemptAt > now) {
      remaining.push(op);
      continue;
    }

    const connector = resolveConnector(op.vibeConnectorId);
    if (!connector) {
      // Can't link while the connector is gone/disabled — keep the op without
      // spending an attempt so it recovers once the connector returns.
      remaining.push(op);
      continue;
    }

    try {
      await linkPr(connector, op.payload);
      recovered += 1;
      changed = true;
      if (onRecovered) await onRecovered(op);
    } catch (error) {
      changed = true;
      op.attempts = (op.attempts || 0) + 1;
      op.updatedAt = now;
      op.lastError = error && error.message ? error.message : String(error);
      const cap = op.maxAttempts || maxAttempts;
      if (op.attempts >= cap) {
        // Give up: a permanently failing link must not retry every poll forever.
        // The PR can still be linked manually from the issue panel.
        if (onExhausted) await onExhausted(op, error);
      } else {
        op.nextAttemptAt = now + retryDelay(op.attempts);
        remaining.push(op);
        if (onFailed) await onFailed(op, error);
      }
    }
  }

  return { remaining, recovered, changed };
}

/**
 * Build a pending PR-link operation for the retry queue.
 *
 * @param {object} args
 * @param {string} args.id Unique id (caller supplies, e.g. randomUUID()).
 * @param {string} args.vibeConnectorId Vibe connector to POST through on retry.
 * @param {string} args.issueId Created Vibe issue id (for logging/observability).
 * @param {object} args.payload The `/v1/pull_request_issues` request body.
 * @param {number} args.now Current epoch ms.
 * @param {number} args.maxAttempts Cap before the op is dropped as exhausted.
 * @param {(attempts: number) => number} args.retryDelay Backoff in ms per attempt.
 * @param {unknown} args.error The failure that triggered the enqueue.
 */
export function buildPullRequestLinkOperation({
  id,
  vibeConnectorId,
  issueId,
  payload,
  now,
  maxAttempts,
  retryDelay,
  error,
}) {
  return {
    id,
    vibeConnectorId,
    issueId,
    label: payload && payload.url ? payload.url : null,
    payload,
    attempts: 1,
    maxAttempts,
    lastError: error && error.message ? error.message : String(error),
    enqueuedAt: now,
    updatedAt: now,
    nextAttemptAt: now + retryDelay(1),
  };
}

/**
 * Pick the connector's own PR→issue link from the rows returned by
 * `GET /v1/pull_request_issues?url=…`.
 *
 * That endpoint returns every `pull_request_issues` row whose PR matches the
 * url, across all of the user's projects. A github_issue_sync connector owns a
 * single project, so we scope to it: a non-null result means the board already
 * has an issue structurally linked to this PR and the worker must NOT create a
 * second one. This is the destination-authoritative dedup that makes review-PR
 * import idempotent regardless of the bounded `seenIds` cache — the board's
 * join row is the durable source of truth, the `seen` set is only an
 * optimization. Returns the matching link, or null when no issue is linked yet
 * (safe to create).
 *
 * @param {Array<{project_id?: string, issue_id?: string}>} links Rows from the list endpoint.
 * @param {string|null|undefined} projectId The connector's Vibe project id.
 * @returns {object|null}
 */
export function selectPullRequestLinkForProject(links, projectId) {
  const rows = Array.isArray(links) ? links : [];
  if (!projectId) return rows[0] || null;
  return rows.find((link) => link && link.project_id === projectId) || null;
}
