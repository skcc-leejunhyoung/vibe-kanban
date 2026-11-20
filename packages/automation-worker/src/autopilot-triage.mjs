import { createHash } from 'node:crypto';

// Autopilot triage: facts and rules decide, before a batch forms, which events
// never need to wake the Autopilot. Anything unproven keeps the agent path.
//
// U1: a completion of work the Autopilot did not dispatch, in a workspace with
// no pull request and no review branch. The Autopilot closes these as noop
// (the user's own sessions).
export const RULES = { U1: 'unowned_completion' };
export const TRIAGE_VERSION = 1;
// Share of drops still delivered in active mode, so the ledger keeps labelling them.
const HOLDOUT_PERCENT = 5;
const COMPLETION_KINDS = new Set(['process.completed', 'process.killed']);

export function isCandidate(event) {
  if (COMPLETION_KINDS.has(event?.kind)) return Boolean(event.executionId && event.hostId);
  return (
    event?.kind === 'cloud.notification' &&
    event.notificationType === 'workspace_task_completed' &&
    event.notificationIntent === 'raw_event' &&
    Boolean(event.notificationId)
  );
}

// Pure decision. `sessions` is every Autopilot session on the owned hosts;
// `legacy` is the Autopilot's own ownership ledger for executions created
// before hosts started recording agent origins.
export function decide({ facts, sessions, legacy }) {
  const agent = (reason) => ({ decision: 'agent', rule: null, reason });
  if (!facts || facts.missing) return agent('facts_unavailable');
  if (facts.autopilot) return agent('autopilot_workspace');
  if (facts.review_branch) return agent('review_branch');
  if (facts.has_pr) return agent('pull_request');
  const owned =
    sessions.has(facts.execution_agent_session) ||
    (facts.workspace_agent_sessions || []).some((id) => sessions.has(id)) ||
    Boolean(
      legacy &&
        (legacy.executions.has(facts.execution_id) ||
          legacy.workspaces.has(facts.workspace_id))
    );
  if (owned) return agent('autopilot_dispatched');
  // Before tracking, a missing origin proves nothing without the ledger.
  if ((facts.execution_before_tracking || facts.workspace_before_tracking) && !legacy)
    return agent('origin_unknown');
  return { decision: 'drop', rule: 'U1', reason: RULES.U1 };
}

export function isHoldout(eventId) {
  const digest = createHash('sha256').update(String(eventId)).digest();
  return digest.readUInt16BE(0) % 100 < HOLDOUT_PERCENT;
}

export function legacySets(saved) {
  if (!saved?.importedAt) return null;
  return {
    executions: new Set(saved.executions || []),
    workspaces: new Set(saved.workspaces || []),
  };
}

// Agent sessions the facts name; one missing from a cached Autopilot list
// may be a just-created Autopilot session.
const namedSessions = (facts) =>
  [facts?.execution_agent_session, ...(facts?.workspace_agent_sessions || [])].filter(Boolean);

// `facts(event)` resolves the completion and reads the host facts,
// `sessions({ fresh })` lists Autopilot sessions on every owned host (cached
// unless `fresh`). Both reject when unsure.
export function createTriage({ facts, sessions, legacy, record, now = Date.now }) {
  return async function triage(event) {
    const startedAt = now();
    let verdict;
    let observed = {};
    try {
      const [found, known] = await Promise.all([facts(event), sessions()]);
      observed = {
        executionId: found.execution_id || null,
        workspaceId: found.workspace_id || null,
        sourceMachineId: found.hostId || null,
      };
      const ledger = legacySets(legacy());
      verdict = decide({ facts: found, sessions: known, legacy: ledger });
      if (verdict.decision === 'drop' && namedSessions(found).some((id) => !known.has(id)))
        verdict = decide({ facts: found, sessions: await sessions({ fresh: true }), legacy: ledger });
    } catch {
      verdict = { decision: 'agent', rule: null, reason: 'facts_unavailable' };
    }
    const entry = {
      at: new Date(startedAt).toISOString(),
      version: TRIAGE_VERSION,
      kind: event.kind,
      hostId: event.hostId || null,
      notificationId: event.notificationId || null,
      executionId: event.executionId || null,
      ...observed,
      ...verdict,
      // Per execution, so a completion and its paired alert share the outcome.
      holdout:
        verdict.decision === 'drop' && isHoldout(observed.executionId || event.id),
      ms: now() - startedAt,
    };
    record(event.id, entry);
    return entry;
  };
}

// Journal of decisions, kept 14 days and at most `limit` entries.
export function pruneJournal(journal, nowMs, limit = 20000) {
  const cutoff = nowMs - 14 * 86400000;
  const kept = Object.entries(journal).filter(([, entry]) => Date.parse(entry.at) >= cutoff);
  kept.sort((a, b) => a[1].at.localeCompare(b[1].at));
  return Object.fromEntries(kept.slice(-limit));
}

// Scores drop decisions against the Autopilot's own ledger (`inbox.json`
// items keyed `exec:<id>`): noop agrees, drawer/sent means the agent acted.
// Applied drops never reached the agent, so only shadow and holdout drops
// carry a label. A rule is promotable after `min` labelled drops with no act.
export function scoreTriage(entries, items, min = 300) {
  const rules = {};
  const seen = new Set();
  for (const entry of entries) {
    if (entry.decision !== 'drop') continue;
    // A completion and its paired alert are one execution, one label.
    const key = `${entry.rule}:${entry.executionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rule = (rules[entry.rule] ||= {
      drops: 0, applied: 0, labelled: 0, noop: 0, acted: 0, unlabelled: 0, misses: [],
    });
    rule.drops += 1;
    if (entry.applied && !entry.holdout) {
      rule.applied += 1;
      continue;
    }
    const status = items[`exec:${entry.executionId}`]?.status;
    if (status === 'noop') rule.noop += 1;
    else if (status === 'drawer' || status === 'sent') {
      rule.acted += 1;
      rule.misses.push({ id: entry.id, executionId: entry.executionId, status });
    } else {
      rule.unlabelled += 1;
      continue;
    }
    rule.labelled += 1;
  }
  for (const rule of Object.values(rules))
    rule.promotable = rule.labelled >= min && rule.acted === 0;
  return rules;
}
