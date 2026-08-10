import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  isNotifiableReview,
  mapWithConcurrency,
  recentlyUpdatedPrs,
  reviewActivity,
} from './github-pr-activity.mjs';
import {
  assertGithubIssueProject,
  backfillLegacyGithubIssueLinks,
  decideGithubMilestoneSync,
  decideGithubParentSync,
  decideGithubProjectStatusSync,
  ensureGithubIssueForLink,
  githubIssueMapBackfillEntries,
  githubIssueSyncVibeConnectorId,
  githubMilestoneMetaDiffers,
  markGithubIssueSeen,
  normalizeOptionalTimestamp,
  planCommentSync,
  runSingleFlight,
  retryPendingGithubIssueLinkOperations,
  selectGithubImportCandidates,
  selectGithubPollCandidates,
  shouldRunGithubIssueSyncRule,
  shouldSyncGithubProjectStatus,
  withCommentMarker,
  withGithubIssueMarker,
  withoutCommentMarker,
  withoutGithubIssueMarker,
} from './github-issue-sync.mjs';
import {
  loadGithubProjectIssues,
  loadGithubProjectsMetadata,
} from './github-projects.mjs';
import {
  canConfirmGithubParentRemoval,
  fetchGithubIssueParent,
  githubIssueLinkKey,
  githubIssueRepository,
  githubIssueRepositoriesShareOwner,
  updateGithubIssueParent,
} from './github-sub-issues.mjs';
import {
  buildPullRequestLinkOperation,
  retryPendingPullRequestLinkOperations,
  selectPullRequestLinkForProject,
} from './pull-request-links.mjs';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.AUTOMATION_DATA_DIR || path.resolve('data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const LOG_PATH = path.join(DATA_DIR, 'logs.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_LOGS = 500;
// Cap request bodies so an authenticated client can't exhaust memory with one
// giant POST (the only writes are connector/rule edits, which stay tiny).
const MAX_BODY_BYTES = 1024 * 1024;
// Rules run as trusted code (node:vm is NOT a security sandbox), so ADMIN_TOKEN
// is the real access control. There is no unauthenticated mode: a tokenless
// server would let any local webpage (CSRF) create and run a rule, i.e. execute
// code on the host. Fail closed — refuse to boot without a token.
if (!ADMIN_TOKEN) {
  console.error(
    'ADMIN_TOKEN is required; refusing to start. Set one (e.g. ADMIN_TOKEN=$(openssl rand -hex 32)) and restart.'
  );
  process.exit(1);
}
const HOST = process.env.HOST || '0.0.0.0';
const RULE_TIMEOUT_MS = Number(process.env.RULE_TIMEOUT_MS || 10000);
// A rule that throws (e.g. the Vibe issue create failed) drops its event into a
// retry queue instead of being lost. Each poll re-attempts due items with
// exponential backoff up to RETRY_MAX_ATTEMPTS; after that the item is marked
// "exhausted" and only retried when an operator manually triggers it.
const RETRY_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.RETRY_MAX_ATTEMPTS || 5)
);
const RETRY_BASE_DELAY_MS = Math.max(
  1000,
  Number(process.env.RETRY_BASE_DELAY_MS || 60000)
);
const RETRY_MAX_DELAY_MS = Math.max(
  RETRY_BASE_DELAY_MS,
  Number(process.env.RETRY_MAX_DELAY_MS || 3600000)
);

const defaultRuleScript = `async function handle(event, ctx) {
  if (event.source !== 'slack' || event.type !== 'message') return;

  const match = event.text.match(/^#issue\\s+([^|\\n]+)(?:\\s*\\|\\s*([\\s\\S]+))?/);
  if (!match) return;

  const title = match[1].trim();
  const body = (match[2] || '').trim();
  const description = [
    body,
    '---',
    'Created from Slack',
    'Channel: ' + event.channelId,
    'Message ts: ' + event.ts,
    event.permalink ? 'Link: ' + event.permalink : null,
  ].filter(Boolean).join('\\n');

  await ctx.actions.vibe.createIssue('vibe-default', {
    title,
    description,
  });
}`;

const defaultGithubRuleScript = `async function handle(event, ctx) {
  if (event.source !== 'github' || (event.type !== 'issue' && event.type !== 'pr')) return;

  const title = event.title;
  const cleanBody = (event.body || '').replace(/<!--[^]*?-->/g, '').trim();
  const description = cleanBody || null;

  await ctx.actions.vibe.createIssue('vibe-default', {
    title: title,
    description: description,
    sourceKey: event.repo + '#' + event.number,
    parentKey: event.parentNumber ? (event.repo + '#' + event.parentNumber) : null,
    tags: event.type === 'pr' ? ['review'] : [],
  });
}`;

const defaultGithubPrCommentRuleScript = `async function handle(event, ctx) {
  if (event.source !== 'github' || event.type !== 'pr_comment') return;

  await ctx.actions.vibe.notifyPullRequestComment('vibe-default', {
    pullRequestUrl: event.pullRequestUrl,
    pullRequestNumber: event.number,
    pullRequestTitle: event.title,
    actorName: event.user || 'Someone',
    commentPreview: (event.body || '').slice(0, 240),
    commentUrl: event.url,
  });
}`;

const defaultState = {
  // Master switch. When false, scheduleAll() installs no poll timers, so the
  // worker stays up (and configurable from the Vibe Kanban settings page) but
  // does no polling/rule work. This is the "turn the worker off" control in the UI.
  enabled: true,
  connectors: [
    {
      id: 'slack-default',
      name: 'Slack channel polling',
      type: 'slack',
      enabled: false,
      config: {
        token: '',
        channelId: '',
        intervalSeconds: 60,
        cursorTs: '0',
        limit: 25,
      },
    },
    {
      id: 'vibe-default',
      name: 'Vibe Kanban issue creator',
      type: 'vibe_kanban',
      enabled: false,
      config: {
        baseUrl: '',
        tokenUrl: '',
        bearerToken: '',
        projectId: '',
        statusId: '',
      },
    },
    {
      id: 'github-default',
      name: 'GitHub issue poller',
      type: 'github',
      enabled: false,
      config: {
        token: '',
        owner: '',
        repo: '',
        filter: 'assigned',
        state: 'open',
        intervalSeconds: 60,
        cursorTs: '',
        seenIds: [],
        limit: 50,
        includePullRequests: false,
        reviewPrs: false,
        notifyPrComments: true,
        prCommentCursorTs: '',
        seenPrCommentIds: [],
        backfill: false,
      },
    },
  ],
  rules: [
    {
      id: 'slack-issue-to-vibe',
      name: 'Slack #issue -> Vibe Kanban issue',
      enabled: true,
      script: defaultRuleScript,
    },
    {
      id: 'github-issue-to-vibe',
      name: 'GitHub assigned issue -> Vibe Kanban issue',
      enabled: true,
      kind: 'github_issue_sync',
      config: {
        githubConnectorId: 'github-default',
        vibeConnectorId: 'vibe-default',
        githubProjectId: '',
        githubStatusFieldId: '',
        statusMappings: [],
        fields: { title: true, description: true, status: true },
      },
      script: defaultGithubRuleScript,
    },
    {
      id: 'github-pr-comment-notification',
      name: 'GitHub related PR comment -> Vibe notification',
      enabled: true,
      script: defaultGithubPrCommentRuleScript,
    },
  ],
  retryQueue: [],
  githubIssueLinkOperations: [],
  pullRequestLinkOperations: [],
};

let state = structuredClone(defaultState);
let logs = [];
const timers = new Map();
const POLLABLE_TYPES = new Set(['slack', 'github']);
// Caches accessed during the initial poll/rule runs that bootstrap() kicks off,
// declared before `await bootstrap()` to avoid a temporal-dead-zone access.
const githubLoginCache = new Map();
const vibeTokenCache = new Map();
const vibeTokenInflight = new Map();
// One in-flight poll per connector. This is used during bootstrap's initial
// scheduleAll() call, so it must be initialized before bootstrap starts.
const pollInFlight = new Map();
// Retry-queue item ids currently being executed, so an overlapping manual
// trigger and poll-driven pass never run the same item (and its side effect)
// twice.
const retryInFlight = new Set();
const githubIssueLinkInFlight = new Map();
let writeQueue = Promise.resolve();

await bootstrap();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    await log('error', 'request failed', {
      error: errorMessage(error),
      url: sanitizeUrl(req.url),
    });
    sendJson(res, status, {
      error: status === 413 ? 'payload too large' : 'internal server error',
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`automation worker listening on http://${HOST}:${PORT}`);
});

async function bootstrap() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  state = await readJson(STATE_PATH, defaultState);
  logs = await readJson(LOG_PATH, []);
  ensureDefaults();
  await persistState();
  scheduleAll();
}

function ensureDefaults() {
  if (typeof state.enabled !== 'boolean') state.enabled = true;
  state.connectors ||= [];
  state.rules ||= [];
  state.retryQueue ||= [];
  state.githubIssueLinkOperations ||= [];
  state.pullRequestLinkOperations ||= [];
  for (const connector of defaultState.connectors) {
    if (!state.connectors.some((item) => item.id === connector.id)) {
      state.connectors.push(structuredClone(connector));
    }
  }
  for (const rule of defaultState.rules) {
    const existing = state.rules.find((item) => item.id === rule.id);
    if (!existing) {
      state.rules.push(structuredClone(rule));
    } else if (rule.kind === 'github_issue_sync' && !existing.kind) {
      existing.kind = rule.kind;
      existing.config = structuredClone(rule.config);
    }
  }
}

async function route(req, res) {
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`
  );
  // Health probe for container orchestration. No auth: it exposes no state and
  // must answer before the admin token is wired up downstream.
  if (url.pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The worker no longer ships its own web UI — it is configured from the Vibe
  // Kanban settings page, which proxies the /api/* routes below. Root just
  // points there instead of serving an editor.
  if (url.pathname === '/' && req.method === 'GET') {
    sendJson(res, 200, {
      service: 'vibe-automation-worker',
      managedBy: 'Vibe Kanban settings',
    });
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    sendState(res);
    return;
  }

  // Master on/off switch (the "disable the worker" control in the settings UI).
  // Off leaves the worker running but installs no poll timers (see scheduleAll).
  if (url.pathname === '/api/settings' && req.method === 'PATCH') {
    const patch = await readBodyJson(req);
    if ('enabled' in patch) state.enabled = Boolean(patch.enabled);
    await persistState();
    scheduleAll();
    await log('info', 'worker settings updated', { enabled: state.enabled });
    sendState(res);
    return;
  }

  if (url.pathname === '/api/logs' && req.method === 'GET') {
    sendJson(res, 200, logs);
    return;
  }

  if (url.pathname === '/api/connectors' && req.method === 'POST') {
    const connector = await readBodyJson(req);
    upsertConnector(connector);
    await persistState();
    scheduleAll();
    await log('info', 'connector saved', {
      id: connector.id,
      type: connector.type,
    });
    sendState(res);
    return;
  }

  if (url.pathname.startsWith('/api/connectors/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    state.connectors = state.connectors.filter(
      (connector) => connector.id !== id
    );
    await persistState();
    scheduleAll();
    await log('info', 'connector deleted', { id });
    sendState(res);
    return;
  }

  if (url.pathname.startsWith('/api/connectors/') && req.method === 'PATCH') {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const patch = await readBodyJson(req);
    const connector = findConnector(id);
    applyConnectorPatch(connector, patch);
    await persistState();
    scheduleAll();
    await log('info', 'connector updated', {
      id,
      patch: Object.keys(patch || {}),
    });
    sendState(res);
    return;
  }

  if (url.pathname === '/api/rules' && req.method === 'POST') {
    const rule = await readBodyJson(req);
    upsertRule(rule);
    await persistState();
    await log('info', 'rule saved', { id: rule.id });
    sendState(res);
    return;
  }

  if (url.pathname.startsWith('/api/rules/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    state.rules = state.rules.filter((rule) => rule.id !== id);
    await persistState();
    await log('info', 'rule deleted', { id });
    sendState(res);
    return;
  }

  if (url.pathname.startsWith('/api/rules/') && req.method === 'PATCH') {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const patch = await readBodyJson(req);
    const rule = findRule(id);
    applyRulePatch(rule, patch);
    await persistState();
    await log('info', 'rule updated', { id, patch: Object.keys(patch || {}) });
    sendState(res);
    return;
  }

  if (url.pathname.startsWith('/api/poll/') && req.method === 'POST') {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const result = await pollConnector(id, true);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/github/projects' && req.method === 'GET') {
    const connector = findConnector(
      String(url.searchParams.get('connectorId') || '')
    );
    sendJson(res, 200, await githubProjectsMetadata(connector));
    return;
  }

  if (url.pathname === '/api/github/issues/link' && req.method === 'POST') {
    sendJson(res, 200, await linkGithubIssue(await readBodyJson(req)));
    return;
  }

  if (url.pathname === '/api/test-event' && req.method === 'POST') {
    const event = await readBodyJson(req);
    await runRules(event);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/retry-queue' && req.method === 'GET') {
    sendJson(res, 200, state.retryQueue || []);
    return;
  }

  // Manual retry trigger. Body: { connectorId?, includeExhausted? }. Forces all
  // matching items now (ignoring backoff); set includeExhausted to also re-try
  // items that already hit the attempt cap — i.e. register the leftover misses.
  if (url.pathname === '/api/retry-queue/process' && req.method === 'POST') {
    const body = await readBodyJson(req).catch(() => ({}));
    const result = await processRetryQueue({
      connectorId: body?.connectorId || null,
      includeExhausted: Boolean(body?.includeExhausted),
      force: true,
    });
    await log('info', 'retry queue processed (manual)', {
      includeExhausted: Boolean(body?.includeExhausted),
      ...result,
    });
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname.startsWith('/api/retry-queue/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const before = (state.retryQueue || []).length;
    removeRetryItem(id);
    if ((state.retryQueue || []).length !== before) {
      await persistState();
      await log('info', 'retry item discarded', { retryId: id });
    }
    sendJson(res, 200, {
      ok: true,
      remaining: (state.retryQueue || []).length,
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

// Token is accepted only via the Authorization header — never a query string,
// which would leak into browser history, proxy access logs, and Referer headers.
function isAuthorized(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return safeEqual(token, ADMIN_TOKEN);
}

// Constant-time token comparison. Hash both sides first so a length mismatch
// can't short-circuit (timingSafeEqual requires equal-length buffers) and the
// token length isn't leaked through timing.
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// Poller-managed runtime state lives in connector.config. Preserve it for
// partial config patches, but let full connector saves from the JSON editor be
// authoritative so operators can reset cursors/dedup maps from the web UI.
const RUNTIME_CONFIG_KEYS = [
  'cursorTs',
  'seenIds',
  'seenNumbers',
  'issueMap',
  'reviewPrIssueMap',
  'tagMap',
  'githubIssueLinkBackfillSkipped',
];

// Credential fields in connector.config. They are replaced with SECRET_MASK in
// every API response so tokens never leave the process in plaintext, and a save
// that echoes the mask back is treated as "unchanged" (see preserveMaskedSecrets).
const SECRET_CONFIG_KEYS = ['token', 'bearerToken', 'authHeaderValue'];
const SECRET_MASK = '__stored__';

function preserveMissingRuntimeConfig(prevConfig, nextConfig) {
  const prev = prevConfig || {};
  for (const key of RUNTIME_CONFIG_KEYS) {
    if (prev[key] !== undefined && nextConfig[key] === undefined) {
      nextConfig[key] = prev[key];
    }
  }
  return nextConfig;
}

// The UI round-trips the masked config on save, so a secret field still set to
// the mask means "unchanged" — restore the stored value instead of overwriting
// the real secret with the sentinel. An unknown mask (no prior value) is dropped.
function preserveMaskedSecrets(prevConfig, nextConfig) {
  const prev = prevConfig || {};
  for (const key of SECRET_CONFIG_KEYS) {
    if (nextConfig[key] !== SECRET_MASK) continue;
    if (prev[key] !== undefined) nextConfig[key] = prev[key];
    else delete nextConfig[key];
  }
  return nextConfig;
}

// Deep copy of state with every credential replaced by the mask, for responses.
function maskState(current) {
  const copy = cloneData(current);
  // Incomplete operations can contain issue titles/descriptions. They are
  // internal recovery state, not automation settings, so never expose them.
  delete copy.githubIssueLinkOperations;
  delete copy.pullRequestLinkOperations;
  for (const connector of copy.connectors || []) {
    const config = connector.config;
    if (!config) continue;
    for (const key of SECRET_CONFIG_KEYS) {
      if (config[key]) config[key] = SECRET_MASK;
    }
  }
  return copy;
}

function sendState(res) {
  sendJson(res, 200, maskState(state));
}

function upsertConnector(input) {
  const connector = normalizeConnector(input);
  const index = state.connectors.findIndex((item) => item.id === connector.id);
  if (index >= 0) {
    preserveMaskedSecrets(state.connectors[index].config, connector.config);
    state.connectors[index] = connector;
  } else {
    preserveMaskedSecrets(undefined, connector.config);
    state.connectors.push(connector);
  }
}

function upsertRule(input) {
  if (!input || typeof input !== 'object') throw new Error('invalid rule');
  const rule = {
    id: String(input.id || slug(input.name) || randomUUID()),
    name: String(input.name || input.id || 'Untitled rule'),
    enabled: Boolean(input.enabled),
    kind: input.kind ? String(input.kind) : 'script',
    config:
      input.config && typeof input.config === 'object'
        ? cloneData(input.config)
        : {},
    script: String(input.script || ''),
  };
  const index = state.rules.findIndex((item) => item.id === rule.id);
  if (index >= 0) state.rules[index] = rule;
  else state.rules.push(rule);
}

// PATCH must not let clients rewrite identity/type fields: `id` and `type` key
// the timers map and poll dispatch. Only mutable fields are accepted.
function applyConnectorPatch(connector, patch) {
  if (!patch || typeof patch !== 'object') throw new Error('invalid patch');
  if ('name' in patch) connector.name = String(patch.name);
  if ('enabled' in patch) connector.enabled = Boolean(patch.enabled);
  if ('config' in patch) {
    const next =
      patch.config && typeof patch.config === 'object' ? patch.config : {};
    const prev = connector.config;
    preserveMissingRuntimeConfig(prev, next);
    preserveMaskedSecrets(prev, next);
    connector.config = next;
  }
}

function applyRulePatch(rule, patch) {
  if (!patch || typeof patch !== 'object') throw new Error('invalid patch');
  if ('name' in patch) rule.name = String(patch.name);
  if ('enabled' in patch) rule.enabled = Boolean(patch.enabled);
  if ('kind' in patch) rule.kind = String(patch.kind);
  if ('config' in patch) {
    rule.config =
      patch.config && typeof patch.config === 'object'
        ? cloneData(patch.config)
        : {};
  }
  if ('script' in patch) rule.script = String(patch.script);
}

function normalizeConnector(input) {
  if (!input || typeof input !== 'object') throw new Error('invalid connector');
  const type = String(input.type || '');
  if (!type) throw new Error('connector type is required');
  return {
    id: String(input.id || `${type}-${randomUUID()}`),
    name: String(input.name || input.id || type),
    type,
    enabled: Boolean(input.enabled),
    config:
      input.config && typeof input.config === 'object' ? input.config : {},
  };
}

function findConnector(id) {
  const connector = state.connectors.find((item) => item.id === id);
  if (!connector) throw new Error(`connector not found: ${id}`);
  return connector;
}

function findRule(id) {
  const rule = state.rules.find((item) => item.id === id);
  if (!rule) throw new Error(`rule not found: ${id}`);
  return rule;
}

function scheduleAll() {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();

  // Master switch off: leave every timer cleared so the worker idles.
  if (state.enabled === false) return;

  for (const connector of state.connectors) {
    if (!connector.enabled || !POLLABLE_TYPES.has(connector.type)) continue;
    // Guard against a non-numeric config value: Number("abc") is NaN, and
    // setInterval(fn, NaN) coerces the delay to 0, spinning the timer.
    const intervalSeconds = Number(connector.config?.intervalSeconds);
    const safeSeconds = Number.isFinite(intervalSeconds) ? intervalSeconds : 60;
    const intervalMs = Math.max(safeSeconds, 10) * 1000;
    const timer = setInterval(() => {
      pollConnector(connector.id, false).catch((error) => {
        log('error', 'poll failed', {
          connectorId: connector.id,
          error: errorMessage(error),
        });
      });
    }, intervalMs);
    timers.set(connector.id, timer);
    pollConnector(connector.id, false).catch((error) => {
      log('error', 'initial poll failed', {
        connectorId: connector.id,
        error: errorMessage(error),
      });
    });
  }
}

function pollConnector(id, manual) {
  const existing = pollInFlight.get(id);
  if (existing) {
    // Interval ticks skip a busy connector; a manual poll awaits the live run
    // so the API still returns a real result rather than a duplicate run.
    if (!manual) return Promise.resolve({ ok: true, skipped: 'in-flight' });
    return existing;
  }
  const run = runPoll(id, manual).finally(() => pollInFlight.delete(id));
  pollInFlight.set(id, run);
  return run;
}

async function runPoll(id, manual) {
  const connector = findConnector(id);
  if (!connector.enabled && !manual) return { ok: true, skipped: 'disabled' };
  // Re-attempt this connector's previously failed events before fetching new
  // ones, so every poll cycle is also a retry cycle.
  await processRetryQueue({ connectorId: id });
  if (connector.type === 'slack') return pollSlack(connector);
  if (connector.type === 'github') return pollGithub(connector);
  throw new Error(`poll not supported for ${connector.type}`);
}

async function pollSlack(connector) {
  const config = connector.config || {};
  if (!config.token || !config.channelId) {
    throw new Error('Slack token and channelId are required');
  }

  const params = new URLSearchParams({
    channel: config.channelId,
    oldest: String(config.cursorTs || '0'),
    inclusive: 'false',
    limit: String(config.limit || 25),
  });
  const response = await fetch(
    `https://slack.com/api/conversations.history?${params}`,
    {
      headers: { Authorization: `Bearer ${config.token}` },
    }
  );
  const body = await response.json();
  if (!body.ok)
    throw new Error(`Slack API error: ${body.error || response.status}`);

  const messages = Array.isArray(body.messages)
    ? body.messages.slice().reverse()
    : [];
  let processed = 0;
  let latestTs = config.cursorTs || '0';

  for (const message of messages) {
    if (!message.ts || message.subtype || !message.text) {
      latestTs = maxSlackTs(latestTs, message.ts || latestTs);
      continue;
    }

    const event = {
      source: 'slack',
      type: 'message',
      connectorId: connector.id,
      channelId: config.channelId,
      text: message.text,
      user: message.user || null,
      ts: message.ts,
      permalink: null,
      raw: message,
    };

    event.permalink = await slackPermalink(
      config.token,
      config.channelId,
      message.ts
    );
    await runRules(event);
    processed += 1;
    latestTs = maxSlackTs(latestTs, message.ts);
  }

  connector.config.cursorTs = latestTs;
  await persistState();
  if (processed > 0) {
    await log('info', 'slack messages processed', {
      connectorId: connector.id,
      processed,
    });
  }
  return { ok: true, processed, cursorTs: latestTs };
}

// GitHub's REST/Search APIs cap per_page at 100; clamp so a larger configured
// limit can't break the pagination loop's "last page" heuristic.
function githubPerPage(config) {
  const limit = Number(config.limit);
  if (!Number.isFinite(limit) || limit < 1) return 50;
  return Math.min(Math.floor(limit), 100);
}

function githubHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'vibe-automation-worker',
  };
}

async function githubLogin(connector) {
  const config = connector.config || {};
  if (config.username) return String(config.username);
  const cached = githubLoginCache.get(connector.id);
  if (cached) return cached;
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(
    /\/+$/,
    ''
  );
  const response = await fetch(`${apiBase}/user`, {
    headers: githubHeaders(config.token),
  });
  if (!response.ok) throw new Error(`GitHub /user failed: ${response.status}`);
  const body = await response.json();
  if (!body.login) throw new Error('GitHub /user returned no login');
  githubLoginCache.set(connector.id, body.login);
  return body.login;
}

// REST issue payloads omit sub-issue links, so resolve parents via GraphQL.
// Returns { issueNumber: parentNumber | null } for the given numbers.
async function githubParentMap(connector, numbers) {
  const config = connector.config || {};
  if (!numbers.length) return {};
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(
    /\/+$/,
    ''
  );
  const fields = numbers
    .map((n) => `i${n}: issue(number: ${n}) { parent { number } }`)
    .join(' ');
  const query = `query { repository(owner: ${JSON.stringify(config.owner)}, name: ${JSON.stringify(config.repo)}) { ${fields} } }`;
  const response = await fetch(`${apiBase}/graphql`, {
    method: 'POST',
    headers: {
      ...githubHeaders(config.token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await response.json();
  const repo = body && body.data && body.data.repository;
  const map = {};
  if (repo) {
    for (const n of numbers) {
      const node = repo[`i${n}`];
      map[n] = node && node.parent ? node.parent.number : null;
    }
  }
  return map;
}

// Order so a parent is imported before its child when both are in the batch.
function orderByParent(issues) {
  const inBatch = new Set(issues.map((i) => i.number));
  const emitted = new Set();
  const result = [];
  let remaining = issues.slice();
  while (remaining.length) {
    const ready = remaining.filter((i) => {
      const p = i.__parent;
      return !p || !inBatch.has(p) || emitted.has(p);
    });
    if (!ready.length) {
      result.push(...remaining);
      break;
    }
    for (const i of ready) {
      result.push(i);
      emitted.add(i.number);
    }
    const readySet = new Set(ready);
    remaining = remaining.filter((i) => !readySet.has(i));
  }
  return result;
}

// PRs where review is requested from the user (open, non-draft) via Search API.
// Returns issue-shaped items (each has a `pull_request` field).
async function githubReviewPrs(connector, login) {
  const config = connector.config || {};
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(
    /\/+$/,
    ''
  );
  const q = `repo:${config.owner}/${config.repo} is:pr is:open draft:false review-requested:${login}`;
  const params = new URLSearchParams({
    q,
    per_page: String(githubPerPage(config)),
    sort: 'updated',
    order: 'desc',
  });
  const response = await fetch(`${apiBase}/search/issues?${params}`, {
    headers: githubHeaders(config.token),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub search error: ${response.status} ${text.slice(0, 200)}`
    );
  }
  const body = JSON.parse(text);
  return Array.isArray(body.items) ? body.items : [];
}

// Fetch a PR's head/base branch names (the issues/search payloads omit them).
async function githubPrBranches(connector, number) {
  const config = connector.config || {};
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(
    /\/+$/,
    ''
  );
  const response = await fetch(
    `${apiBase}/repos/${config.owner}/${config.repo}/pulls/${number}`,
    { headers: githubHeaders(config.token) }
  );
  if (!response.ok) return null;
  const pr = await response.json();
  return {
    headRef: pr.head && pr.head.ref ? pr.head.ref : null,
    baseRef: pr.base && pr.base.ref ? pr.base.ref : null,
  };
}

async function githubRelatedPrs(connector, login) {
  const config = connector.config || {};
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(
    /\/+$/,
    ''
  );
  const qualifiers = [
    `author:${login}`,
    `assignee:${login}`,
    `review-requested:${login}`,
    `reviewed-by:${login}`,
  ];
  const prs = new Map();
  for (const qualifier of qualifiers) {
    const params = new URLSearchParams({
      q: `repo:${config.owner}/${config.repo} is:pr ${qualifier}`,
      per_page: String(githubPerPage(config)),
      sort: 'updated',
      order: 'desc',
    });
    const response = await fetch(`${apiBase}/search/issues?${params}`, {
      headers: githubHeaders(config.token),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub related PR search error: ${response.status} ${text.slice(0, 200)}`
      );
    }
    const body = JSON.parse(text);
    for (const pr of Array.isArray(body.items) ? body.items : []) {
      prs.set(pr.number, pr);
    }
  }
  return Array.from(prs.values());
}

async function githubPrComments(connector, since) {
  const config = connector.config || {};
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(
    /\/+$/,
    ''
  );
  const base = `${apiBase}/repos/${config.owner}/${config.repo}`;
  const fetchComments = async (endpoint) => {
    const comments = [];
    for (let page = 1; page <= 20; page += 1) {
      const params = new URLSearchParams({
        per_page: '100',
        page: String(page),
        sort: 'updated',
        direction: 'asc',
      });
      if (since) params.set('since', since);
      const response = await fetch(`${endpoint}?${params}`, {
        headers: githubHeaders(config.token),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `GitHub PR comments error: ${response.status} ${text.slice(0, 200)}`
        );
      }
      const pageComments = JSON.parse(text);
      for (const comment of pageComments) comments.push(comment);
      if (!Array.isArray(pageComments) || pageComments.length < 100) break;
    }
    return comments;
  };
  const [issueComments, reviewComments] = await Promise.all([
    fetchComments(`${base}/issues/comments`),
    fetchComments(`${base}/pulls/comments`),
  ]);
  return [...issueComments, ...reviewComments];
}

async function githubPrReviews(connector, prs, login, since) {
  const config = connector.config || {};
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(
    /\/+$/,
    ''
  );
  const base = `${apiBase}/repos/${config.owner}/${config.repo}`;
  const reviewGroups = await mapWithConcurrency(prs, 4, async (pr) => {
    const reviews = [];
    for (let page = 1; page <= 20; page += 1) {
      const params = new URLSearchParams({
        per_page: '100',
        page: String(page),
      });
      const response = await fetch(
        `${base}/pulls/${pr.number}/reviews?${params}`,
        {
          headers: githubHeaders(config.token),
        }
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `GitHub PR reviews error: ${response.status} ${text.slice(0, 200)}`
        );
      }
      const pageReviews = JSON.parse(text);
      for (const review of pageReviews) {
        if (isNotifiableReview(review, login, since)) {
          reviews.push({ pr, activity: reviewActivity(review) });
        }
      }
      if (!Array.isArray(pageReviews) || pageReviews.length < 100) break;
    }
    return reviews;
  });
  return reviewGroups.flat();
}

function githubCommentPrNumber(comment) {
  const url = String(comment.pull_request_url || comment.issue_url || '');
  const number = Number(url.split('/').pop());
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function pollGithubPrComments(connector, login) {
  const config = connector.config || {};
  if (config.notifyPrComments === false) return { processed: 0, seeded: 0 };
  const cursor = String(config.prCommentCursorTs || '');
  const seeding = !cursor && (config.seenPrCommentIds || []).length === 0;
  const pollStartedAt = new Date().toISOString();
  if (seeding) {
    config.prCommentCursorTs = pollStartedAt;
    config.seenPrCommentIds = [];
    return { processed: 0, seeded: 0 };
  }

  const seen = new Set(config.seenPrCommentIds || []);
  const prs = await githubRelatedPrs(connector, login);
  const prsByNumber = new Map(prs.map((pr) => [pr.number, pr]));
  // Search results can lag behind comment APIs. Re-read a short overlap so a
  // newly related/updated PR can appear before its comment falls behind the
  // cursor; seen IDs keep the overlap idempotent.
  const cursorMs = Date.parse(cursor);
  const since = Number.isFinite(cursorMs)
    ? new Date(cursorMs - 5 * 60 * 1000).toISOString()
    : cursor;
  const [comments, reviews] = await Promise.all([
    githubPrComments(connector, since),
    githubPrReviews(connector, recentlyUpdatedPrs(prs, since), login, since),
  ]);
  const pending = [];

  for (const comment of comments) {
    const pr = prsByNumber.get(githubCommentPrNumber(comment));
    if (!pr) continue;
    const key = `${comment.url || ''}:${comment.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (comment.user && comment.user.login === login) continue;
    pending.push({ pr, comment });
  }
  for (const { pr, activity } of reviews) {
    const key = `${activity.url || ''}:${activity.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push({ pr, comment: activity });
  }

  pending.sort((a, b) =>
    String(a.comment.created_at || '').localeCompare(
      String(b.comment.created_at || '')
    )
  );
  for (const { pr, comment } of pending) {
    await runRules({
      source: 'github',
      type: 'pr_comment',
      connectorId: connector.id,
      repo: `${config.owner}/${config.repo}`,
      number: pr.number,
      title: pr.title,
      pullRequestUrl: pr.html_url,
      url: comment.html_url,
      user: comment.user ? comment.user.login : null,
      body: comment.body || '',
      createdAt: comment.created_at,
      reviewState: comment.review_state || null,
      raw: comment,
    });
  }

  config.prCommentCursorTs = pollStartedAt;
  config.seenPrCommentIds = Array.from(seen).slice(-2000);
  return { processed: pending.length, seeded: 0 };
}

async function pollGithub(connector) {
  const config = connector.config || {};
  if (!config.token || !config.owner || !config.repo) {
    throw new Error('GitHub token, owner, and repo are required');
  }
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(
    /\/+$/,
    ''
  );
  const filter = String(config.filter || 'assigned');
  const field =
    { assigned: 'assignee', created: 'creator', mentioned: 'mentioned' }[
      filter
    ] || 'assignee';
  const login = await githubLogin(connector);
  const commentResult = await pollGithubPrComments(connector, login);

  // GitHub caps per_page at 100; an unclamped larger limit would make the
  // "batch shorter than perPage -> last page" check fire after page 1 and
  // silently drop the rest (notably during backfill).
  const perPage = String(githubPerPage(config));
  const issuesUrl = `${apiBase}/repos/${config.owner}/${config.repo}/issues`;

  async function fetchPage(page, withSince) {
    const params = new URLSearchParams({
      state: String(config.state || 'open'),
      sort: 'updated',
      direction: 'desc',
      per_page: perPage,
      page: String(page),
    });
    params.set(field, login);
    if (withSince && config.cursorTs)
      params.set('since', String(config.cursorTs));
    const response = await fetch(`${issuesUrl}?${params}`, {
      headers: githubHeaders(config.token),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${text.slice(0, 200)}`
      );
    }
    return JSON.parse(text);
  }

  // Backfill ignores the incremental cursor and walks every page so the whole
  // assigned history is imported; normal polls walk pages filtered by `since`.
  // Both paginate (bounded to 20 pages) — fetching only page 1 while the cursor
  // jumps to the newest would silently drop a burst of >limit issues updated in
  // a single interval.
  let items = [];
  const useSince = !config.backfill;
  for (let page = 1; page <= 20; page += 1) {
    const batch = await fetchPage(page, useSince);
    if (!Array.isArray(batch) || !batch.length) break;
    items = items.concat(batch);
    if (batch.length < Number(perPage)) break;
  }

  // The first poll only seeds the "seen" set so enabling the connector doesn't
  // flood the board with every already-assigned issue. Set backfill:true to
  // create issues for the existing backlog instead.
  const seeding =
    !config.backfill && !config.cursorTs && (config.seenIds || []).length === 0;
  const seen = new Set(config.seenIds || []);
  const seenNumbers = new Set(config.seenNumbers || []);
  let processed = 0;
  let latest = config.cursorTs || '';

  // Optionally add PRs where review is requested from the user (open, non-draft).
  if (config.reviewPrs) {
    const prs = await githubReviewPrs(connector, login);
    for (const pr of prs) {
      pr.__reviewPr = true;
      items.push(pr);
    }
  }

  const repository = `${config.owner}/${config.repo}`;
  const projectIds = [
    ...new Set(
      state.rules
        .filter(
          (rule) =>
            rule.enabled &&
            rule.kind === 'github_issue_sync' &&
            rule.config?.githubConnectorId === connector.id &&
            rule.config?.githubProjectId
        )
        .map((rule) => rule.config.githubProjectId)
    ),
  ];
  for (const projectId of projectIds) {
    let projectItems;
    try {
      projectItems = await loadGithubProjectIssues(
        connector,
        projectId,
        repository,
        githubGraphql,
        { login, filter, state: config.state || 'open' }
      );
    } catch (error) {
      // A deleted project, revoked `read:project` scope, or a transient GraphQL
      // error must not wedge the whole connector poll — otherwise REST import,
      // milestone/status reconcile, and cursor persistence would be skipped
      // every cycle. Degrade to REST-only for this poll; recovers next cycle.
      await log('warn', 'github project issues load failed', {
        connectorId: connector.id,
        projectId,
        error: errorMessage(error),
      });
      continue;
    }
    items = [
      // Scoped exactly like the REST poll above — a Project board also holds
      // other people's issues, which must never be imported or written to.
      ...projectItems,
      ...items,
    ];
  }

  const { candidates, latest: candidateLatest } = selectGithubPollCandidates({
    items,
    seen,
    seenNumbers,
    includePullRequests: config.includePullRequests,
    latest,
  });
  latest = candidateLatest;

  const { importCandidates, seedOnly } = selectGithubImportCandidates({
    candidates,
    seeding,
  });
  for (const issue of seedOnly) markGithubIssueSeen(issue, seen, seenNumbers);
  if (importCandidates.length) {
    // REST omits the parent link; GraphQL has it. Resolve each new issue's
    // parent, then import parents before children so a child can link to its
    // parent's Vibe id within the same batch.
    const parentMap = await githubParentMap(
      connector,
      importCandidates.map((i) => i.number)
    );
    for (const issue of importCandidates)
      issue.__parent = parentMap[issue.number] || null;
    for (const issue of orderByParent(importCandidates)) {
      markGithubIssueSeen(issue, seen, seenNumbers);
      let headRef = null;
      let baseRef = null;
      if (issue.pull_request) {
        const branches = await githubPrBranches(connector, issue.number);
        if (branches) {
          headRef = branches.headRef;
          baseRef = branches.baseRef;
        }
      }
      const event = {
        source: 'github',
        type: issue.__reviewPr ? 'pr' : 'issue',
        connectorId: connector.id,
        repo: `${config.owner}/${config.repo}`,
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        state: issue.state,
        user: issue.user ? issue.user.login : null,
        assignees: (issue.assignees || []).map((a) => a.login),
        labels: (issue.labels || []).map((l) =>
          typeof l === 'string' ? l : l.name
        ),
        body: issue.body || '',
        parentNumber: issue.__parent,
        headRef,
        baseRef,
        updatedAt: issue.updated_at,
        raw: issue,
      };
      await runRules(event);
      processed += 1;
    }
  }

  const syncResult = await reconcileGithubIssueRules(connector);
  // Recover any structural PR→issue links whose create POST failed on a prior
  // poll. No-op (single length check) when the queue is empty, which is the norm.
  await retryPendingPullRequestLinks();
  connector.config.cursorTs = latest;
  connector.config.seenIds = Array.from(seen).slice(-1000);
  connector.config.seenNumbers = Array.from(seenNumbers).slice(-1000);
  await persistState();
  if (seeding) {
    await log(
      'info',
      'github connector seeded (no issues created on first poll)',
      {
        connectorId: connector.id,
        seeded: seen.size,
      }
    );
  } else if (processed > 0) {
    await log('info', 'github issues processed', {
      connectorId: connector.id,
      processed,
    });
  }
  return {
    ok: true,
    processed,
    seeded: seeding ? seen.size : 0,
    cursorTs: latest,
    commentsProcessed: commentResult.processed,
    commentsSeeded: commentResult.seeded,
    linksSynced: syncResult.synced,
    linksRecovered: syncResult.recovered,
    linksBackfilled: syncResult.backfilled,
  };
}

async function githubGraphql(connector, query, variables = {}) {
  const config = connector.config || {};
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(
    /\/+$/,
    ''
  );
  const endpoint = apiBase.endsWith('/api/v3')
    ? `${apiBase.slice(0, -7)}/api/graphql`
    : 'https://api.github.com/graphql';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: githubHeaders(config.token),
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub GraphQL error: ${response.status} ${text.slice(0, 300)}`
    );
  }
  const body = JSON.parse(text);
  if (Array.isArray(body.errors) && body.errors.length) {
    throw new Error(`GitHub GraphQL error: ${body.errors[0].message}`);
  }
  return body.data;
}

async function githubProjectsMetadata(connector) {
  return loadGithubProjectsMetadata(connector, githubGraphql);
}

function parseGithubIssueUrl(value) {
  const match = String(value || '')
    .trim()
    .match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/
    );
  if (!match) throw new Error('invalid GitHub issue URL');
  return {
    repository: `${match[1]}/${match[2]}`,
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
  };
}

async function addGithubIssueToProject(connector, projectId, contentId) {
  if (!projectId) return null;
  const data = await githubGraphql(
    connector,
    `mutation($project:ID!,$content:ID!) {
      addProjectV2ItemById(input:{projectId:$project,contentId:$content}) {
        item { id }
      }
    }`,
    { project: projectId, content: contentId }
  );
  return data?.addProjectV2ItemById?.item?.id || null;
}

async function updateGithubProjectStatus(connector, config, itemId, optionId) {
  if (
    !config.githubProjectId ||
    !config.githubStatusFieldId ||
    !itemId ||
    !optionId
  )
    return;
  await githubGraphql(
    connector,
    `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!) {
      updateProjectV2ItemFieldValue(input:{
        projectId:$project,itemId:$item,fieldId:$field,
        value:{singleSelectOptionId:$option}
      }) { projectV2Item { id } }
    }`,
    {
      project: config.githubProjectId,
      item: itemId,
      field: config.githubStatusFieldId,
      option: optionId,
    }
  );
}

async function githubProjectStatusOption(connector, itemId, fieldId) {
  if (!itemId || !fieldId) return null;
  const data = await githubGraphql(
    connector,
    `query($item:ID!) {
      node(id:$item) {
        ... on ProjectV2Item {
          fieldValues(first:50) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                optionId
                field { ... on ProjectV2SingleSelectField { id } }
              }
            }
          }
        }
      }
    }`,
    { item: itemId }
  );
  const value = (data?.node?.fieldValues?.nodes || []).find(
    (entry) => entry?.field?.id === fieldId
  );
  return value?.optionId || null;
}

function githubIssueLinkOperationKey(ruleId, issueId) {
  return `${ruleId}:${issueId}`;
}

function compactGithubIssue(issue) {
  return {
    number: issue.number,
    html_url: issue.html_url,
    node_id: issue.node_id,
    state: issue.state,
    updated_at: issue.updated_at,
    title: issue.title,
    body: issue.body ?? null,
    milestone: issue.milestone
      ? {
          number: issue.milestone.number,
          title: issue.milestone.title,
          due_on: issue.milestone.due_on ?? null,
          state: issue.milestone.state,
          closed_at: issue.milestone.closed_at ?? null,
          updated_at: issue.milestone.updated_at ?? issue.updated_at ?? null,
        }
      : null,
    pull_request: issue.pull_request ? {} : undefined,
  };
}

async function fetchGithubIssueByUrl(connector, inputUrl) {
  const config = connector.config || {};
  const parsed = parseGithubIssueUrl(inputUrl);
  const expected = `${config.owner}/${config.repo}`.toLowerCase();
  if (parsed.repository.toLowerCase() !== expected) {
    throw new Error(`issue must belong to configured repository ${expected}`);
  }
  const response = await fetch(
    `${String(config.apiBase || 'https://api.github.com').replace(/\/+$/, '')}/repos/${parsed.repository}/issues/${parsed.number}`,
    { headers: githubHeaders(config.token) }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub issue lookup error: ${response.status} ${text.slice(0, 300)}`
    );
  }
  const issue = JSON.parse(text);
  if (issue.pull_request)
    throw new Error('pull request URLs cannot be linked as GitHub issues');
  return compactGithubIssue(issue);
}

async function findGithubIssueByMarker(connector, marker, createdAt) {
  const config = connector.config || {};
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(
    /\/+$/,
    ''
  );
  const since = new Date(
    Math.max(0, Date.parse(createdAt) - 10 * 60_000)
  ).toISOString();
  for (let page = 1; page <= 20; page += 1) {
    const params = new URLSearchParams({
      state: 'all',
      since,
      sort: 'created',
      direction: 'asc',
      per_page: '100',
      page: String(page),
    });
    const response = await fetch(
      `${apiBase}/repos/${config.owner}/${config.repo}/issues?${params}`,
      { headers: githubHeaders(config.token) }
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub issue recovery error: ${response.status} ${text.slice(0, 300)}`
      );
    }
    const issues = JSON.parse(text);
    const match = issues.find(
      (issue) =>
        !issue.pull_request && String(issue.body || '').includes(marker)
    );
    if (match) return compactGithubIssue(match);
    if (issues.length < 100) break;
  }
  return null;
}

async function createGithubIssue(connector, { title, body }) {
  const config = connector.config || {};
  const response = await fetch(
    `${String(config.apiBase || 'https://api.github.com').replace(/\/+$/, '')}/repos/${config.owner}/${config.repo}/issues`,
    {
      method: 'POST',
      headers: githubHeaders(config.token),
      body: JSON.stringify({ title, body }),
    }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub issue create error: ${response.status} ${text.slice(0, 300)}`
    );
  }
  return compactGithubIssue(JSON.parse(text));
}

async function findGithubIssueLinkForIssue(vibe, issueId) {
  const body = await vibeApi(
    vibe,
    'GET',
    `/v1/github_issue_links?issue_id=${encodeURIComponent(issueId)}`
  );
  return body?.github_issue_links?.[0] || null;
}

// Reverse-lookup: does the board already have an issue structurally linked to
// this PR url? Used as an idempotency backstop before creating a review issue —
// see selectPullRequestLinkForProject for why the `seen` cache alone is not
// enough. Returns the connector-owned link, or null when no issue is linked yet.
async function findPullRequestLinkByUrl(vibe, url, projectId) {
  const body = await vibeApi(
    vibe,
    'GET',
    `/v1/pull_request_issues?url=${encodeURIComponent(url)}`
  );
  return selectPullRequestLinkForProject(
    body?.pull_request_issues || [],
    projectId
  );
}

async function syncGithubMilestone({
  github,
  vibe,
  projectId,
  repository,
  issueId,
  githubMilestone,
  githubIssueUpdatedAt,
  syncLink,
  milestones,
  issueMilestones,
}) {
  const allMilestones =
    milestones ??
    (await vibeApi(
      vibe,
      'GET',
      `/v1/project_milestones?project_id=${encodeURIComponent(projectId)}`
    ));
  const allIssueMilestones =
    issueMilestones ??
    (await vibeApi(
      vibe,
      'GET',
      `/v1/issue_milestones?project_id=${encodeURIComponent(projectId)}`
    ));
  // Reflect a persisted milestone back into the shared `allMilestones` cache so
  // another issue that shares this milestone later in the same reconcile reads
  // the updated row (e.g. the source repo/number just written) instead of a
  // stale copy — otherwise it would re-create the GitHub milestone (422) or
  // re-issue redundant PATCHes.
  const cacheMilestone = (updated) => {
    const cached = allMilestones.find((item) => item.id === updated.id);
    if (cached) {
      Object.assign(cached, updated);
      return cached;
    }
    allMilestones.push(updated);
    return updated;
  };
  const currentLink = allIssueMilestones.find(
    (item) => item.issue_id === issueId
  );
  let currentMilestone = currentLink
    ? allMilestones.find((item) => item.id === currentLink.milestone_id)
    : null;
  const githubNumber = githubMilestone?.number ?? null;
  const assignmentsMatch = Boolean(
    currentMilestone &&
      githubMilestone &&
      String(currentMilestone.source_repository || '').toLowerCase() ===
        repository.toLowerCase() &&
      currentMilestone.source_number === githubNumber
  );
  const decision = decideGithubMilestoneSync({
    baselineMilestoneId: syncLink?.synced_milestone_id,
    baselineGithubNumber: syncLink?.synced_github_milestone_number,
    vibeMilestoneId: currentMilestone?.id,
    githubMilestoneNumber: githubNumber,
    assignmentsMatch,
    vibeUpdatedAt: currentMilestone?.updated_at,
    githubUpdatedAt: githubMilestone?.updated_at || githubIssueUpdatedAt,
  });
  const apiBase = String(
    github?.config?.apiBase || 'https://api.github.com'
  ).replace(/\/+$/, '');

  if (decision.direction === 'to_github') {
    if (!currentMilestone) {
      const response = await fetch(
        `${apiBase}/repos/${repository}/issues/${syncLink.number}`,
        {
          method: 'PATCH',
          headers: githubHeaders(github.config.token),
          body: JSON.stringify({ milestone: null }),
        }
      );
      if (!response.ok)
        throw new Error(
          `GitHub milestone unlink error: ${response.status} ${(await response.text()).slice(0, 200)}`
        );
      return { milestoneId: null, githubNumber: null };
    }
    let targetNumber =
      String(currentMilestone.source_repository || '').toLowerCase() ===
      repository.toLowerCase()
        ? currentMilestone.source_number
        : null;
    const milestonePayload = {
      title: currentMilestone.name,
      due_on: currentMilestone.target_date,
      state: currentMilestone.completed_at ? 'closed' : 'open',
    };
    const milestoneResponse = await fetch(
      targetNumber
        ? `${apiBase}/repos/${repository}/milestones/${targetNumber}`
        : `${apiBase}/repos/${repository}/milestones`,
      {
        method: targetNumber ? 'PATCH' : 'POST',
        headers: githubHeaders(github.config.token),
        body: JSON.stringify(milestonePayload),
      }
    );
    const milestoneText = await milestoneResponse.text();
    if (!milestoneResponse.ok)
      throw new Error(
        `GitHub milestone write error: ${milestoneResponse.status} ${milestoneText.slice(0, 200)}`
      );
    const writtenMilestone = JSON.parse(milestoneText);
    targetNumber = writtenMilestone.number;
    if (!currentMilestone.source_repository) {
      const response = await vibeApi(
        vibe,
        'PATCH',
        `/v1/project_milestones/${encodeURIComponent(currentMilestone.id)}`,
        { source_repository: repository, source_number: targetNumber }
      );
      currentMilestone = cacheMilestone(response.data);
    }
    const issueResponse = await fetch(
      `${apiBase}/repos/${repository}/issues/${syncLink.number}`,
      {
        method: 'PATCH',
        headers: githubHeaders(github.config.token),
        body: JSON.stringify({ milestone: targetNumber }),
      }
    );
    if (!issueResponse.ok)
      throw new Error(
        `GitHub milestone assignment error: ${issueResponse.status} ${(await issueResponse.text()).slice(0, 200)}`
      );
    return { milestoneId: currentMilestone.id, githubNumber: targetNumber };
  }

  if (decision.direction === 'to_vibe') {
    if (!githubMilestone) {
      if (currentLink) {
        await vibeApi(
          vibe,
          'DELETE',
          `/v1/issue_milestones/${encodeURIComponent(currentLink.id)}`
        );
        const index = allIssueMilestones.indexOf(currentLink);
        if (index >= 0) allIssueMilestones.splice(index, 1);
      }
      return { milestoneId: null, githubNumber: null };
    }

    let milestone = allMilestones.find(
      (item) =>
        String(item.source_repository || '').toLowerCase() ===
          repository.toLowerCase() &&
        item.source_number === githubMilestone.number
    );
    const completedAt =
      githubMilestone.state === 'closed' ? githubMilestone.closed_at : null;
    if (!milestone) {
      const response = await vibeApi(vibe, 'POST', '/v1/project_milestones', {
        project_id: projectId,
        name: githubMilestone.title,
        start_date: null,
        target_date: githubMilestone.due_on,
        completed_at: completedAt,
        source_repository: repository,
        source_number: githubMilestone.number,
      });
      milestone = cacheMilestone(response.data);
    } else if (githubMilestoneMetaDiffers(milestone, githubMilestone)) {
      const response = await vibeApi(
        vibe,
        'PATCH',
        `/v1/project_milestones/${encodeURIComponent(milestone.id)}`,
        {
          name: githubMilestone.title,
          target_date: githubMilestone.due_on,
          completed_at: completedAt,
        }
      );
      milestone = cacheMilestone(response.data);
    }

    if (currentLink?.milestone_id !== milestone.id) {
      const response = await vibeApi(vibe, 'POST', '/v1/issue_milestones', {
        issue_id: issueId,
        milestone_id: milestone.id,
      });
      if (currentLink) Object.assign(currentLink, response.data);
      else allIssueMilestones.push(response.data);
    }
    return { milestoneId: milestone.id, githubNumber };
  }

  if (currentMilestone && githubMilestone) {
    const metadataDiffers = githubMilestoneMetaDiffers(
      currentMilestone,
      githubMilestone
    );
    if (metadataDiffers) {
      const localIsNewer =
        Date.parse(currentMilestone.updated_at || '') >
        Date.parse(githubMilestone.updated_at || githubIssueUpdatedAt || '');
      if (localIsNewer) {
        const response = await fetch(
          `${apiBase}/repos/${repository}/milestones/${githubNumber}`,
          {
            method: 'PATCH',
            headers: githubHeaders(github.config.token),
            body: JSON.stringify({
              title: currentMilestone.name,
              due_on: currentMilestone.target_date,
              state: currentMilestone.completed_at ? 'closed' : 'open',
            }),
          }
        );
        if (!response.ok)
          throw new Error(
            `GitHub milestone update error: ${response.status} ${(await response.text()).slice(0, 200)}`
          );
      } else {
        await vibeApi(
          vibe,
          'PATCH',
          `/v1/project_milestones/${encodeURIComponent(currentMilestone.id)}`,
          {
            name: githubMilestone.title,
            target_date: githubMilestone.due_on,
            completed_at:
              githubMilestone.state === 'closed'
                ? githubMilestone.closed_at
                : null,
          }
        );
      }
    }
  }
  return {
    milestoneId: currentMilestone?.id ?? null,
    githubNumber,
  };
}

function removeGithubIssueLinkOperation(key) {
  state.githubIssueLinkOperations = (
    state.githubIssueLinkOperations || []
  ).filter((operation) => operation.key !== key);
}

async function linkGithubIssue(input) {
  const key = githubIssueLinkOperationKey(
    String(input.ruleId || 'github-issue-to-vibe'),
    String(input.issueId || '')
  );
  return runSingleFlight(githubIssueLinkInFlight, key, () =>
    linkGithubIssueOnce(input, key)
  );
}

async function linkGithubIssueOnce(input, operationKey) {
  const rule = findRule(String(input.ruleId || 'github-issue-to-vibe'));
  if (rule.kind !== 'github_issue_sync')
    throw new Error('rule is not github_issue_sync');
  if (!rule.enabled) throw new Error('github issue sync rule is disabled');
  const config = rule.config || {};
  const github = findConnector(String(config.githubConnectorId || ''));
  const vibe = findConnector(String(config.vibeConnectorId || ''));
  if (!github.enabled)
    throw new Error(`GitHub connector is disabled: ${github.id}`);
  if (github.type !== 'github')
    throw new Error(`connector is not github: ${github.id}`);
  if (!vibe.enabled) throw new Error(`Vibe connector is disabled: ${vibe.id}`);
  if (vibe.type !== 'vibe_kanban') {
    throw new Error(`connector is not vibe_kanban: ${vibe.id}`);
  }
  const githubConfig = github.config || {};
  if (!githubConfig.token || !githubConfig.owner || !githubConfig.repo) {
    throw new Error('GitHub token, owner, and repo are required');
  }
  if (!vibe.config?.projectId) throw new Error('Vibe projectId is required');
  const vibeIssue = await vibeApi(
    vibe,
    'GET',
    `/v1/issues/${encodeURIComponent(input.issueId)}`
  );
  assertGithubIssueProject(vibeIssue, vibe.config.projectId);
  const existingLink = await findGithubIssueLinkForIssue(vibe, input.issueId);
  if (existingLink) {
    removeGithubIssueLinkOperation(operationKey);
    await persistState();
    return existingLink;
  }

  const title = String(input.title || '').trim();
  if (!title) throw new Error('issue title is required');
  let operation = (state.githubIssueLinkOperations || []).find(
    (item) => item.key === operationKey
  );
  if (!operation) {
    operation = {
      key: operationKey,
      ruleId: rule.id,
      githubConnectorId: github.id,
      vibeConnectorId: vibe.id,
      createdAt: new Date().toISOString(),
      input: cloneData(input),
      githubIssue: null,
      projectItemId: input.projectItemId || null,
    };
    state.githubIssueLinkOperations.push(operation);
    await persistState();
  } else if (!operation.githubIssue) {
    // Validation-only failures for an existing URL are safe to correct and retry.
    operation.input = cloneData(input);
    await persistState();
  }

  const effectiveInput = operation.input;
  let issue;
  try {
    issue = await ensureGithubIssueForLink({
      mode: effectiveInput.mode,
      issueId: effectiveInput.issueId,
      url: effectiveInput.url,
      title: String(effectiveInput.title || '').trim(),
      description: effectiveInput.description,
      operation,
      findCreatedIssue: (marker, createdAt) =>
        findGithubIssueByMarker(github, marker, createdAt),
      createIssue: (payload) => createGithubIssue(github, payload),
      fetchExistingIssue: (url) => fetchGithubIssueByUrl(github, url),
      persistOperation: persistState,
    });
  } catch (error) {
    if (effectiveInput.mode === 'existing' && !operation.githubIssue) {
      removeGithubIssueLinkOperation(operationKey);
      await persistState();
    }
    throw error;
  }

  if (!operation.projectItemId && config.githubProjectId) {
    operation.projectItemId = await addGithubIssueToProject(
      github,
      config.githubProjectId,
      issue.node_id
    );
    await persistState();
  }
  const projectItemId = operation.projectItemId || null;
  // A brand new link has no synced baseline, so the board's existing Status is
  // the source of truth. Pushing the Vibe import column here is what rewrote a
  // whole project to one column when the poll imported an existing backlog.
  let syncedStatusOptionId = null;
  let syncedVibeStatusId = effectiveInput.statusId || null;
  if (shouldSyncGithubProjectStatus(config) && projectItemId) {
    const currentOptionId = await githubProjectStatusOption(
      github,
      projectItemId,
      config.githubStatusFieldId
    );
    const decision = decideGithubProjectStatusSync({
      statusMappings: config.statusMappings,
      vibeStatusId: effectiveInput.statusId,
      syncedVibeStatusId: null,
      githubOptionId: currentOptionId,
      syncedGithubOptionId: null,
    });
    if (decision.action === 'push') {
      await updateGithubProjectStatus(
        github,
        config,
        projectItemId,
        decision.githubOptionId
      );
    } else if (
      decision.action === 'adopt' &&
      decision.vibeStatusId !== effectiveInput.statusId
    ) {
      await vibeApi(
        vibe,
        'PATCH',
        `/v1/issues/${encodeURIComponent(effectiveInput.issueId)}`,
        { status_id: decision.vibeStatusId }
      );
    }
    syncedStatusOptionId = decision.githubOptionId;
    syncedVibeStatusId = decision.vibeStatusId || null;
  }

  const repository = `${githubConfig.owner}/${githubConfig.repo}`;
  const created = await vibeApi(vibe, 'POST', '/v1/github_issue_links', {
    issue_id: effectiveInput.issueId,
    repository,
    number: issue.number,
    url: issue.html_url,
    github_node_id: issue.node_id,
    project_item_id: projectItemId,
    github_state: issue.state,
    github_updated_at: normalizeOptionalTimestamp(issue.updated_at),
    last_synced_vibe_updated_at: normalizeOptionalTimestamp(
      vibeIssue.updated_at,
      effectiveInput.vibeUpdatedAt
    ),
    synced_title: String(effectiveInput.title || ''),
    synced_description:
      effectiveInput.description == null
        ? null
        : String(effectiveInput.description),
    synced_vibe_status_id: syncedVibeStatusId,
    synced_github_status_option_id: syncedStatusOptionId,
    synced_parent_issue_id: null,
    synced_milestone_id: null,
    synced_github_milestone_number: null,
  });
  const milestoneSync = await syncGithubMilestone({
    github,
    vibe,
    projectId: vibe.config.projectId,
    repository,
    issueId: effectiveInput.issueId,
    githubMilestone: issue.milestone,
    githubIssueUpdatedAt: issue.updated_at,
    syncLink: created.data,
  });
  await vibeApi(
    vibe,
    'PATCH',
    `/v1/github_issue_links/${encodeURIComponent(created.data.id)}`,
    {
      synced_milestone_id: milestoneSync.milestoneId,
      synced_github_milestone_number: milestoneSync.githubNumber,
    }
  );
  removeGithubIssueLinkOperation(operationKey);
  await persistState();
  await log('info', 'github issue linked', {
    ruleId: rule.id,
    issueId: input.issueId,
    githubUrl: issue.html_url,
    created: effectiveInput.mode === 'create',
  });
  return created;
}

// Non-throwing mirror of linkGithubIssueOnce's rule/connector preconditions:
// true only when the op's rule and both connectors still exist and are enabled.
// A missing/disabled target must not spend a retry attempt (it recovers once the
// target returns); permanent misconfigurations (wrong kind/type) still fall
// through to linkIssue and exhaust normally.
function githubIssueLinkTargetAvailable(operation) {
  const rule = state.rules.find(
    (item) => item.id === String(operation.ruleId || 'github-issue-to-vibe')
  );
  if (!rule || !rule.enabled) return false;
  const config = rule.config || {};
  const github = state.connectors.find(
    (item) => item.id === String(config.githubConnectorId || '')
  );
  if (!github || !github.enabled) return false;
  const vibe = state.connectors.find(
    (item) => item.id === String(config.vibeConnectorId || '')
  );
  if (!vibe || !vibe.enabled) return false;
  return true;
}

async function retryPendingGithubIssueLinks(githubConnector) {
  const operations = state.githubIssueLinkOperations || [];
  if (!operations.length) return 0;
  const snapshot = [...operations];
  const { remaining, recovered, changed } =
    await retryPendingGithubIssueLinkOperations({
      operations: snapshot,
      connectorId: githubConnector.id,
      now: Date.now(),
      maxAttempts: RETRY_MAX_ATTEMPTS,
      retryDelay,
      linkIssue: linkGithubIssue,
      isAvailable: githubIssueLinkTargetAvailable,
      onFailure: async (operation, error) => {
        await log('warn', 'pending github issue link retry failed', {
          ruleId: operation.ruleId,
          issueId: operation.input?.issueId,
          attempts: operation.attempts,
          error: errorMessage(error),
        });
      },
      onExhausted: async (operation, error) => {
        await log('error', 'pending github issue link retry exhausted', {
          ruleId: operation.ruleId,
          issueId: operation.input?.issueId,
          attempts: operation.attempts,
          error: errorMessage(error),
        });
      },
    });
  if (changed) {
    // linkGithubIssue may have enqueued new ops while we were retrying; keep
    // anything that was not part of this pass.
    const seen = new Set(snapshot);
    const added = (state.githubIssueLinkOperations || []).filter(
      (operation) => !seen.has(operation)
    );
    state.githubIssueLinkOperations = [...remaining, ...added];
    await persistState();
  }
  return recovered;
}

// Re-attempt structural PR→issue links whose create POST failed during issue
// creation. Steady-state cost is a single empty-array check per poll; work
// happens only after a (rare) transient failure. See pull-request-links.mjs.
async function retryPendingPullRequestLinks() {
  const operations = state.pullRequestLinkOperations || [];
  if (!operations.length) return 0;
  const { remaining, recovered, changed } =
    await retryPendingPullRequestLinkOperations({
      operations,
      now: Date.now(),
      maxAttempts: RETRY_MAX_ATTEMPTS,
      retryDelay,
      resolveConnector: (id) => {
        const connector = state.connectors.find((item) => item.id === id);
        return connector && connector.enabled ? connector : null;
      },
      linkPr: (connector, payload) =>
        vibeApi(connector, 'POST', '/v1/pull_request_issues', payload),
      onRecovered: (op) =>
        log('info', 'vibe PR link recovered', {
          connectorId: op.vibeConnectorId,
          issueId: op.issueId,
          prUrl: op.payload?.url,
          attempts: op.attempts,
        }),
      onFailed: (op) =>
        log('warn', 'vibe PR link retry failed', {
          connectorId: op.vibeConnectorId,
          issueId: op.issueId,
          prUrl: op.payload?.url,
          attempts: op.attempts,
          error: op.lastError,
        }),
      onExhausted: (op) =>
        log('error', 'vibe PR link retry exhausted', {
          connectorId: op.vibeConnectorId,
          issueId: op.issueId,
          prUrl: op.payload?.url,
          attempts: op.attempts,
          error: op.lastError,
        }),
    });
  if (changed) {
    state.pullRequestLinkOperations = remaining;
    await persistState();
  }
  return recovered;
}

async function backfillGithubIssueMapLinks({
  rule,
  github,
  vibe,
  issues,
  links,
}) {
  const repository = `${github.config.owner}/${github.config.repo}`;
  const skipped = (vibe.config.githubIssueLinkBackfillSkipped ||= []);
  const entries = githubIssueMapBackfillEntries({
    issueMap: vibe.config.issueMap,
    repository,
    linkedIssueIds: links.map((link) => link.issue_id),
    skippedSourceKeys: skipped,
  });
  let skipStateChanged = false;
  const result = await backfillLegacyGithubIssueLinks({
    entries,
    issues,
    repository,
    ruleId: rule.id,
    linkIssue: linkGithubIssue,
    onPullRequest: async (entry) => {
      skipped.push(entry.sourceKey);
      skipStateChanged = true;
    },
    onFailure: async (entry, issue, error) => {
      await log('warn', 'legacy github issue link backfill failed', {
        ruleId: rule.id,
        issueId: issue.id,
        sourceKey: entry.sourceKey,
        error: errorMessage(error),
      });
    },
  });
  if (skipStateChanged) await persistState();
  return result.linked;
}

async function reconcileGithubIssueRules(githubConnector) {
  let synced = 0;
  const recovered = await retryPendingGithubIssueLinks(githubConnector);
  let backfilled = 0;
  const rules = state.rules.filter(
    (rule) =>
      rule.enabled &&
      rule.kind === 'github_issue_sync' &&
      rule.config?.githubConnectorId === githubConnector.id
  );
  for (const rule of rules) {
    const config = rule.config || {};
    const vibe = findConnector(String(config.vibeConnectorId || ''));
    if (!vibe.enabled || !vibe.config?.projectId) continue;
    const [linksBody, issuesBody, milestones, issueMilestones] =
      await Promise.all([
        vibeApi(
          vibe,
          'GET',
          `/v1/github_issue_links?project_id=${encodeURIComponent(vibe.config.projectId)}`
        ),
        vibeApi(
          vibe,
          'GET',
          `/v1/issues?project_id=${encodeURIComponent(vibe.config.projectId)}`
        ),
        vibeApi(
          vibe,
          'GET',
          `/v1/project_milestones?project_id=${encodeURIComponent(vibe.config.projectId)}`
        ),
        vibeApi(
          vibe,
          'GET',
          `/v1/issue_milestones?project_id=${encodeURIComponent(vibe.config.projectId)}`
        ),
      ]);
    const issues = new Map(
      ((issuesBody && issuesBody.issues) || []).map((issue) => [
        issue.id,
        issue,
      ])
    );
    const links = (linksBody && linksBody.github_issue_links) || [];
    const linksByIssueId = new Map(
      links.map((candidate) => [candidate.issue_id, candidate])
    );
    const linksByExternalKey = new Map(
      links.map((candidate) => [githubIssueLinkKey(candidate), candidate])
    );
    backfilled += await backfillGithubIssueMapLinks({
      rule,
      github: githubConnector,
      vibe,
      issues,
      links,
    });
    for (const link of links) {
      if (
        String(link.repository).toLowerCase() !==
        `${githubConnector.config.owner}/${githubConnector.config.repo}`.toLowerCase()
      ) {
        continue;
      }
      const vibeIssue = issues.get(link.issue_id);
      if (!vibeIssue) continue;
      try {
        await reconcileGithubIssueLink(
          rule,
          githubConnector,
          vibe,
          link,
          vibeIssue,
          { linksByIssueId, linksByExternalKey, milestones, issueMilestones }
        );
        synced += 1;
      } catch (error) {
        await log('warn', 'github issue sync failed', {
          ruleId: rule.id,
          issueId: link.issue_id,
          githubUrl: link.url,
          error: errorMessage(error),
        });
      }
    }
  }
  return { synced, recovered, backfilled };
}

async function reconcileGithubIssueParent({
  github,
  vibe,
  apiBase,
  link,
  vibeIssue,
  external,
  linksByIssueId,
  linksByExternalKey,
}) {
  const vibeParentLink = vibeIssue.parent_issue_id
    ? linksByIssueId.get(vibeIssue.parent_issue_id)
    : null;
  if (vibeIssue.parent_issue_id && !vibeParentLink) return undefined;

  const requestHeaders = githubHeaders(github.config.token);
  const githubParent = await fetchGithubIssueParent({
    fetchImpl: fetch,
    apiBase,
    link,
    headers: requestHeaders,
  });
  if (!githubParent && link.synced_parent_issue_id) {
    const previousParentLink = linksByIssueId.get(link.synced_parent_issue_id);
    const canConfirmRemoval = await canConfirmGithubParentRemoval({
      fetchImpl: fetch,
      apiBase,
      childLink: link,
      previousParentLink,
      headers: requestHeaders,
    });
    if (!canConfirmRemoval) return undefined;
  }
  const githubParentRepository = githubParent
    ? githubIssueRepository(githubParent)
    : null;
  if (githubParent && !githubParentRepository) return undefined;
  const githubParentLink = githubParent
    ? linksByExternalKey.get(
        githubIssueLinkKey({
          repository: githubParentRepository,
          number: githubParent.number,
        })
      )
    : null;
  if (githubParent && !githubParentLink) return undefined;

  const decision = decideGithubParentSync({
    baselineParentIssueId: link.synced_parent_issue_id,
    vibeParentIssueId: vibeParentLink?.issue_id || null,
    githubParentIssueId: githubParentLink?.issue_id || null,
    vibeUpdatedAt: vibeIssue.updated_at,
    githubUpdatedAt: external.updated_at,
  });
  if (decision.direction === 'to_github') {
    const nextParentLink = decision.parentIssueId
      ? linksByIssueId.get(decision.parentIssueId)
      : null;
    if (
      nextParentLink &&
      !githubIssueRepositoriesShareOwner(
        nextParentLink.repository,
        link.repository
      )
    ) {
      return undefined;
    }
    await updateGithubIssueParent({
      fetchImpl: fetch,
      apiBase,
      child: external,
      currentParent: githubParent,
      nextParentLink,
      headers: requestHeaders,
    });
  } else if (decision.direction === 'to_vibe') {
    await vibeApi(
      vibe,
      'PATCH',
      `/v1/issues/${encodeURIComponent(vibeIssue.id)}`,
      { parent_issue_id: decision.parentIssueId }
    );
    vibeIssue.parent_issue_id = decision.parentIssueId;
  }
  return decision.parentIssueId;
}

async function reconcileGithubIssueLink(
  rule,
  github,
  vibe,
  link,
  vibeIssue,
  { linksByIssueId, linksByExternalKey, milestones, issueMilestones }
) {
  const config = rule.config || {};
  const syncTitle = config.fields?.title !== false;
  const syncDescription = config.fields?.description !== false;
  const apiBase = String(
    github.config.apiBase || 'https://api.github.com'
  ).replace(/\/+$/, '');
  const response = await fetch(
    `${apiBase}/repos/${link.repository}/issues/${link.number}`,
    { headers: githubHeaders(github.config.token) }
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `GitHub issue lookup error: ${response.status} ${text.slice(0, 200)}`
    );
  const external = JSON.parse(text);
  const milestoneSync = await syncGithubMilestone({
    github,
    vibe,
    projectId: vibe.config.projectId,
    repository: link.repository,
    issueId: link.issue_id,
    githubMilestone: external.milestone,
    githubIssueUpdatedAt: external.updated_at,
    syncLink: link,
    milestones,
    issueMilestones,
  });
  const hasVibeMarker = String(external.body || '').includes(
    '<!-- vibe-kanban-issue:'
  );
  const externalDescription = withoutGithubIssueMarker(external.body);
  const syncedDescription = link.synced_description ?? null;
  const githubChanged =
    (syncTitle && external.title !== link.synced_title) ||
    (syncDescription && externalDescription !== syncedDescription);
  const vibeChanged =
    (syncTitle && vibeIssue.title !== link.synced_title) ||
    (syncDescription && (vibeIssue.description ?? null) !== syncedDescription);
  let title = vibeIssue.title;
  let description = vibeIssue.description ?? null;

  if (
    githubChanged &&
    (!vibeChanged ||
      Date.parse(external.updated_at) >= Date.parse(vibeIssue.updated_at))
  ) {
    if (syncTitle) title = external.title;
    if (syncDescription) description = externalDescription;
    await vibeApi(
      vibe,
      'PATCH',
      `/v1/issues/${encodeURIComponent(vibeIssue.id)}`,
      {
        ...(syncTitle ? { title } : {}),
        ...(syncDescription ? { description } : {}),
      }
    );
  } else if (vibeChanged) {
    const update = await fetch(
      `${apiBase}/repos/${link.repository}/issues/${link.number}`,
      {
        method: 'PATCH',
        headers: githubHeaders(github.config.token),
        body: JSON.stringify({
          ...(syncTitle ? { title } : {}),
          ...(syncDescription
            ? {
                body: hasVibeMarker
                  ? withGithubIssueMarker(description, vibeIssue.id)
                  : description,
              }
            : {}),
        }),
      }
    );
    if (!update.ok) {
      throw new Error(
        `GitHub issue update error: ${update.status} ${(await update.text()).slice(0, 200)}`
      );
    }
  }

  let githubStatusOption = link.synced_github_status_option_id ?? null;
  if (shouldSyncGithubProjectStatus(config)) {
    githubStatusOption = await githubProjectStatusOption(
      github,
      link.project_item_id,
      config.githubStatusFieldId
    );
    // Links written before a baseline existed (or by a legacy import) adopt the
    // board value instead of pushing the Vibe column back over it.
    const decision = decideGithubProjectStatusSync({
      statusMappings: config.statusMappings,
      vibeStatusId: vibeIssue.status_id,
      syncedVibeStatusId: link.synced_vibe_status_id ?? null,
      githubOptionId: githubStatusOption,
      syncedGithubOptionId: link.synced_github_status_option_id ?? null,
    });
    if (decision.action === 'push') {
      await updateGithubProjectStatus(
        github,
        config,
        link.project_item_id,
        decision.githubOptionId
      );
      githubStatusOption = decision.githubOptionId;
    } else if (decision.action === 'adopt') {
      if (decision.vibeStatusId !== vibeIssue.status_id) {
        await vibeApi(
          vibe,
          'PATCH',
          `/v1/issues/${encodeURIComponent(vibeIssue.id)}`,
          {
            status_id: decision.vibeStatusId,
          }
        );
      }
      vibeIssue.status_id = decision.vibeStatusId;
    }
  }

  const syncedParentIssueId = await reconcileGithubIssueParent({
    github,
    vibe,
    apiBase,
    link,
    vibeIssue,
    external,
    linksByIssueId,
    linksByExternalKey,
  });

  await vibeApi(
    vibe,
    'PATCH',
    `/v1/github_issue_links/${encodeURIComponent(link.id)}`,
    {
      project_item_id: link.project_item_id,
      github_state: external.state,
      github_updated_at: external.updated_at,
      last_synced_vibe_updated_at: vibeIssue.updated_at,
      synced_title: syncTitle ? title : undefined,
      synced_description: syncDescription ? description : undefined,
      synced_vibe_status_id: vibeIssue.status_id,
      synced_github_status_option_id: githubStatusOption,
      ...(syncedParentIssueId !== undefined
        ? { synced_parent_issue_id: syncedParentIssueId }
        : {}),
      synced_milestone_id: milestoneSync.milestoneId,
      synced_github_milestone_number: milestoneSync.githubNumber,
    }
  );

  if (config.fields?.comments !== false) {
    try {
      await reconcileGithubIssueComments(github, vibe, link, external, apiBase);
    } catch (error) {
      // Comment sync is best-effort: a failure here must not undo the title/
      // status/etc. reconcile that already persisted above.
      await log('warn', 'github comment sync failed', {
        ruleId: rule.id,
        issueId: link.issue_id,
        githubUrl: link.url,
        error: errorMessage(error),
      });
    }
  }
}

// Fetch every comment on a mapped GitHub issue. Capped at 20 pages.
// ponytail: full scan, no ?since cursor — add github_issue_links.comments_synced_after
// as a `since` if an issue ever exceeds ~2000 comments.
async function fetchGithubIssueComments(apiBase, repository, number, token) {
  const comments = [];
  for (let page = 1; page <= 20; page += 1) {
    const params = new URLSearchParams({ per_page: '100', page: String(page) });
    const response = await fetch(
      `${apiBase}/repos/${repository}/issues/${number}/comments?${params}`,
      { headers: githubHeaders(token) }
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub issue comments error: ${response.status} ${text.slice(0, 200)}`
      );
    }
    const batch = JSON.parse(text);
    for (const comment of batch) comments.push(comment);
    if (!Array.isArray(batch) || batch.length < 100) break;
  }
  return comments;
}

async function githubCreateIssueComment(apiBase, repository, number, token, body) {
  const response = await fetch(
    `${apiBase}/repos/${repository}/issues/${number}/comments`,
    {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({ body }),
    }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub create comment error: ${response.status} ${text.slice(0, 200)}`
    );
  }
  return JSON.parse(text);
}

async function githubUpdateIssueComment(apiBase, repository, token, commentId, body) {
  const response = await fetch(
    `${apiBase}/repos/${repository}/issues/comments/${commentId}`,
    {
      method: 'PATCH',
      headers: githubHeaders(token),
      body: JSON.stringify({ body }),
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub update comment error: ${response.status} ${text.slice(0, 200)}`
    );
  }
}

// Bidirectional comment reconcile for one mapped issue. Scope is the 1:1 link
// (its repository/number and issue_id); planCommentSync applies the seeding
// cutoff and echo/native filters so nothing leaks in from — or out to —
// unrelated issues, PRs, or pre-existing history.
async function reconcileGithubIssueComments(github, vibe, link, external, apiBase) {
  // G1: a link should only ever point at an issue, but never sync a PR's
  // conversation as issue comments even if one slipped through.
  if (external && external.pull_request) return;
  const token = github.config.token;

  // G0 seeding: on the link's first comment reconcile, only stamp the cutoff.
  // Everything already on either side stays put; sync begins with the next
  // comment created after this instant.
  if (!link.comments_synced_after) {
    await vibeApi(
      vibe,
      'PATCH',
      `/v1/github_issue_links/${encodeURIComponent(link.id)}`,
      { comments_synced_after: new Date().toISOString() }
    );
    return;
  }

  const [githubComments, vibeBody] = await Promise.all([
    fetchGithubIssueComments(apiBase, link.repository, link.number, token),
    vibeApi(
      vibe,
      'GET',
      `/v1/issue_comments?issue_id=${encodeURIComponent(link.issue_id)}`
    ),
  ]);
  const plan = planCommentSync({
    githubComments,
    vibeComments: (vibeBody && vibeBody.issue_comments) || [],
    cutoff: link.comments_synced_after,
  });

  for (const repair of plan.repairs) {
    await vibeApi(
      vibe,
      'PATCH',
      `/v1/issue_comments/${encodeURIComponent(repair.vibeCommentId)}`,
      { github_comment_id: repair.githubCommentId }
    );
  }
  for (const gc of plan.imports) {
    await vibeApi(vibe, 'POST', '/v1/issue_comments', {
      issue_id: link.issue_id,
      parent_id: null,
      message: withoutCommentMarker(gc.body),
      github_comment_id: String(gc.id),
      github_author_login: gc.user?.login ?? null,
    });
  }
  for (const vc of plan.pushes) {
    const created = await githubCreateIssueComment(
      apiBase,
      link.repository,
      link.number,
      token,
      withCommentMarker(vc.message, vc.id)
    );
    await vibeApi(
      vibe,
      'PATCH',
      `/v1/issue_comments/${encodeURIComponent(vc.id)}`,
      { github_comment_id: String(created.id) }
    );
  }
  for (const edit of plan.edits) {
    if (edit.direction === 'to_vibe') {
      await vibeApi(
        vibe,
        'PATCH',
        `/v1/issue_comments/${encodeURIComponent(edit.vibe.id)}`,
        { message: edit.message }
      );
    } else {
      await githubUpdateIssueComment(
        apiBase,
        link.repository,
        token,
        edit.github.id,
        withCommentMarker(edit.vibe.message, edit.vibe.id)
      );
    }
  }
}

async function slackPermalink(token, channel, messageTs) {
  try {
    const params = new URLSearchParams({ channel, message_ts: messageTs });
    const response = await fetch(
      `https://slack.com/api/chat.getPermalink?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const body = await response.json();
    return body.ok ? body.permalink : null;
  } catch {
    return null;
  }
}

async function runRules(event) {
  for (const rule of state.rules) {
    if (!rule.enabled) continue;
    try {
      await runRule(rule, event);
    } catch (error) {
      await log('error', 'rule failed', {
        ruleId: rule.id,
        eventSource: event.source,
        error: errorMessage(error),
      });
      // The event itself was valid (it polled successfully); the rule's side
      // effect failed. Queue it so the next poll re-attempts rather than losing
      // it — the source connector's cursor has already advanced past it.
      await enqueueRetry(rule, event, error);
    }
  }
}

// Backoff grows exponentially per attempt, capped, so a persistently failing
// item doesn't hammer the API every poll.
function retryDelay(attempts) {
  const delay = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, RETRY_MAX_DELAY_MS);
}

async function enqueueRetry(rule, event, error) {
  state.retryQueue ||= [];
  const now = Date.now();
  const item = {
    id: randomUUID(),
    ruleId: rule.id,
    connectorId: event.connectorId || null,
    source: event.source || null,
    label: event.title || event.text || event.url || null,
    event: cloneData(event),
    attempts: 1,
    maxAttempts: RETRY_MAX_ATTEMPTS,
    status: 'pending',
    lastError: errorMessage(error),
    enqueuedAt: now,
    updatedAt: now,
    nextAttemptAt: now + retryDelay(1),
  };
  state.retryQueue.push(item);
  await log('warn', 'event queued for retry', {
    retryId: item.id,
    ruleId: rule.id,
    connectorId: item.connectorId,
    attempts: item.attempts,
    maxAttempts: item.maxAttempts,
    nextAttemptAt: new Date(item.nextAttemptAt).toISOString(),
    error: item.lastError,
  });
  await persistState();
}

function removeRetryItem(id) {
  state.retryQueue = (state.retryQueue || []).filter((item) => item.id !== id);
}

// Re-run queued rule failures. Called automatically each poll (for the polling
// connector's due items) and manually via the API. `force` ignores the backoff
// timer; `includeExhausted` also retries items that already hit the cap.
async function processRetryQueue({
  connectorId = null,
  includeExhausted = false,
  force = false,
} = {}) {
  const now = Date.now();
  const summary = { retried: 0, succeeded: 0, failed: 0, exhausted: 0 };
  // Snapshot so concurrent enqueues (from a parallel poll) don't disturb iteration.
  for (const item of [...(state.retryQueue || [])]) {
    if (connectorId && item.connectorId !== connectorId) continue;
    if (item.status === 'exhausted' && !includeExhausted) continue;
    if (!force && item.status === 'pending' && (item.nextAttemptAt || 0) > now)
      continue;
    // Claim the item so a concurrent run (e.g. a manual trigger overlapping the
    // poll-driven pass) can't execute the same rule twice — there is no
    // idempotency key, so a double run means a duplicate side effect.
    if (retryInFlight.has(item.id)) continue;

    const rule = state.rules.find((entry) => entry.id === item.ruleId);
    if (!rule) {
      // The rule was deleted; the item can never succeed — drop it.
      removeRetryItem(item.id);
      await log('warn', 'retry item dropped (rule missing)', {
        retryId: item.id,
        ruleId: item.ruleId,
      });
      continue;
    }
    if (!rule.enabled) continue;

    retryInFlight.add(item.id);
    summary.retried += 1;
    try {
      await runRule(rule, item.event);
      removeRetryItem(item.id);
      summary.succeeded += 1;
      await log('info', 'retry succeeded', {
        retryId: item.id,
        ruleId: item.ruleId,
        attempts: item.attempts,
      });
    } catch (error) {
      item.attempts += 1;
      item.lastError = errorMessage(error);
      item.updatedAt = Date.now();
      if (item.attempts >= item.maxAttempts) {
        item.status = 'exhausted';
        item.nextAttemptAt = null;
        summary.exhausted += 1;
        await log('error', 'retry exhausted', {
          retryId: item.id,
          ruleId: item.ruleId,
          attempts: item.attempts,
          error: item.lastError,
        });
      } else {
        item.status = 'pending';
        item.nextAttemptAt = Date.now() + retryDelay(item.attempts);
        summary.failed += 1;
        await log('warn', 'retry failed', {
          retryId: item.id,
          ruleId: item.ruleId,
          attempts: item.attempts,
          error: item.lastError,
        });
      }
    } finally {
      retryInFlight.delete(item.id);
    }
  }
  if (summary.retried > 0) await persistState();
  summary.remaining = (state.retryQueue || []).length;
  return { ok: true, ...summary };
}

async function runRule(rule, event) {
  if (!shouldRunGithubIssueSyncRule(rule, event)) return;
  // Hand the script a detached copy so a rule can't mutate live state/event.
  // (Hygiene, not a security boundary — vm is not a sandbox.)
  const safeEvent = cloneData(event);
  const context = {
    event: safeEvent,
    ctx: createRuleContext(rule, safeEvent),
    console: {
      log: (...args) => log('info', 'rule console', { ruleId: rule.id, args }),
      warn: (...args) => log('warn', 'rule console', { ruleId: rule.id, args }),
      error: (...args) =>
        log('error', 'rule console', { ruleId: rule.id, args }),
    },
  };
  vm.createContext(context);
  const wrapped = `${rule.script}\n;handle(event, ctx);`;
  const script = new vm.Script(wrapped, {
    filename: `${rule.id}.js`,
    timeout: 1000,
  });
  const result = script.runInContext(context, { timeout: 1000 });
  // The vm timeout only bounds synchronous code; bound async work on the clock
  // too so a slow/hung rule cannot stall the poll loop indefinitely.
  if (result && typeof result.then === 'function') {
    await withTimeout(result, RULE_TIMEOUT_MS, `rule ${rule.id} timed out`);
  }
}

function createRuleContext(rule, event) {
  return {
    log: (level, message, meta = {}) =>
      log(level, message, { ruleId: rule.id, ...meta }),
    connectors: cloneData(state.connectors),
    actions: {
      vibe: {
        createIssue: (connectorId, input) =>
          createVibeIssue(connectorId, input, event, rule),
        notifyPullRequestComment: (connectorId, input) =>
          createVibePullRequestCommentNotification(connectorId, input),
      },
      http: {
        request: async (url, options = {}) => {
          const response = await fetch(url, options);
          return {
            ok: response.ok,
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: await response.text(),
          };
        },
      },
    },
  };
}

async function createVibePullRequestCommentNotification(connectorId, input) {
  const connector = findConnector(connectorId);
  if (!connector.enabled)
    throw new Error(`Vibe connector is disabled: ${connectorId}`);
  if (connector.type !== 'vibe_kanban') {
    throw new Error(`connector is not vibe_kanban: ${connectorId}`);
  }
  const config = connector.config || {};
  if (!config.projectId) throw new Error('Vibe projectId is required');
  return vibeApi(connector, 'POST', '/v1/notifications/pull-request-comment', {
    project_id: config.projectId,
    pull_request_url: String(input.pullRequestUrl || ''),
    pull_request_number: Number(input.pullRequestNumber),
    pull_request_title: String(input.pullRequestTitle || ''),
    actor_name: String(input.actorName || 'Someone'),
    comment_preview: input.commentPreview ? String(input.commentPreview) : null,
    comment_url: input.commentUrl ? String(input.commentUrl) : null,
  });
}

async function createVibeIssue(connectorId, input, event, rule) {
  const effectiveConnectorId = githubIssueSyncVibeConnectorId(
    rule,
    connectorId
  );
  const connector = findConnector(effectiveConnectorId);
  if (!connector.enabled)
    throw new Error(`Vibe connector is disabled: ${effectiveConnectorId}`);
  if (connector.type !== 'vibe_kanban') {
    throw new Error(`connector is not vibe_kanban: ${effectiveConnectorId}`);
  }

  const config = connector.config || {};
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !config.projectId || !config.statusId) {
    throw new Error('Vibe baseUrl, projectId, and statusId are required');
  }

  // Idempotency for review PRs. A review-requested PR is deduped in-poll only by
  // `seenIds`, which is capped at the most-recent 1000 ids and never refreshes
  // an entry's recency, so a PR that stays open while >1000 newer items churn
  // through the connector is evicted and re-surfaced — the worker would then
  // create a *second* `review` issue for the same PR. A DB unique constraint
  // cannot prevent this: `pull_request_issues` is intentionally many-to-many and
  // its row requires the issue to exist first, so the duplicate issue precedes
  // any (rejected) link and would only be orphaned. So dedup here, in two layers:
  if (event && event.type === 'pr' && event.url) {
    // Layer 1 — durable, url-keyed local record written at creation (below).
    // url is collision-free across repos (unlike sourceKey), survives `seenIds`
    // eviction, and is independent of the pull_request_issues link, so a failed
    // or dropped link-POST retry can't cause a re-import.
    const reviewPrIssueMap = (connector.config.reviewPrIssueMap =
      connector.config.reviewPrIssueMap || {});
    if (reviewPrIssueMap[event.url]) {
      await log('info', 'vibe PR already imported; skipping duplicate issue', {
        connectorId: effectiveConnectorId,
        prUrl: event.url,
        issueId: reviewPrIssueMap[event.url],
      });
      return null;
    }
    // Layer 2 — ask the board itself, so a runtime-map reset (operator clears
    // reviewPrIssueMap/seenIds from the JSON editor) still won't duplicate an
    // issue that already exists and is linked. Heals the local map on a hit.
    let existingLink = null;
    try {
      existingLink = await findPullRequestLinkByUrl(
        connector,
        event.url,
        config.projectId
      );
    } catch (error) {
      // A transient lookup failure must not block the connector's primary job
      // (surfacing review PRs). Fall through and create — no worse than the
      // pre-backstop behavior, and the next poll's lookup still converges.
      await log('warn', 'vibe PR link lookup failed; creating anyway', {
        connectorId: effectiveConnectorId,
        prUrl: event.url,
        error: errorMessage(error),
      });
    }
    if (existingLink) {
      reviewPrIssueMap[event.url] = existingLink.issue_id;
      await persistState();
      await log('info', 'vibe PR already linked; skipping duplicate issue', {
        connectorId: effectiveConnectorId,
        prUrl: event.url,
        issueId: existingLink.issue_id,
      });
      return null;
    }
  }

  const payload = {
    project_id: config.projectId,
    status_id: config.statusId,
    title: String(input.title || '').trim(),
    description: input.description ? String(input.description) : null,
    priority: input.priority || null,
    start_date: null,
    target_date: null,
    completed_at: null,
    sort_order: Date.now(),
    parent_issue_id: null,
    parent_issue_sort_order: null,
    extension_metadata: {
      source: event.source,
      source_connector_id: event.connectorId,
      source_event_ts: event.ts || null,
      automation_rule_id: rule.id,
      ...(input.extension_metadata || {}),
    },
  };

  if (!payload.title) throw new Error('issue title is required');

  // Link to a parent issue when the source's parent was already imported — its
  // Vibe id is recorded in this connector's issueMap, keyed by source.
  const issueMap = (connector.config.issueMap =
    connector.config.issueMap || {});
  if (input.parentKey && issueMap[input.parentKey]) {
    payload.parent_issue_id = issueMap[input.parentKey];
  }

  const body = await postVibeIssue(connector, payload);
  const createdId = body && body.data && body.data.id;
  if (input.sourceKey && createdId) {
    issueMap[input.sourceKey] = createdId;
    await persistState();
  }
  // Record the url-keyed idempotency entry the guard above reads. Written even
  // if the pull_request_issues link POST below fails, so a re-surfaced PR is
  // recognized regardless of link state.
  if (event && event.type === 'pr' && event.url && createdId) {
    (connector.config.reviewPrIssueMap =
      connector.config.reviewPrIssueMap || {})[event.url] = createdId;
    await persistState();
  }
  const tags = Array.isArray(input.tags) ? input.tags.filter(Boolean) : [];
  if (createdId && tags.length) {
    for (const name of tags) {
      try {
        const tagId = await resolveVibeTag(connector, payload.project_id, name);
        if (tagId) await attachVibeTag(connector, createdId, tagId);
      } catch (error) {
        await log('warn', 'vibe tag failed', {
          connectorId: effectiveConnectorId,
          tag: name,
          error: errorMessage(error),
        });
      }
    }
  }
  if (
    createdId &&
    event &&
    event.type === 'issue' &&
    event.url &&
    rule.kind === 'github_issue_sync'
  ) {
    try {
      await linkGithubIssue({
        ruleId: rule.id,
        mode: 'existing',
        url: event.url,
        issueId: createdId,
        title: payload.title,
        description: payload.description,
        statusId: payload.status_id,
        vibeUpdatedAt: body?.data?.updated_at || null,
        projectItemId: event.raw?.project_item_id || null,
      });
    } catch (error) {
      await log('warn', 'github issue database link failed', {
        connectorId: effectiveConnectorId,
        issueId: createdId,
        githubUrl: event.url,
        error: errorMessage(error),
      });
    }
  }
  // Structurally link the GitHub PR to the Vibe issue (pull_request_issues join),
  // not just as a URL in the description body — Vibe's review mode only activates
  // when this join row exists; a plain URL in the body is ignored. The stored
  // html_url matches what the local gh `listOpenPrs` returns, so review mode's
  // URL match succeeds. Best-effort but NOT lost on a transient failure: the PR
  // id is already in `seen`, so without recovery the worker would never revisit
  // the PR and the issue would keep its `review` tag but never get its link. On
  // failure we queue it for retry on the next poll (see retryPendingPullRequestLinks).
  if (createdId && event && event.type === 'pr' && event.url) {
    const prRaw = (event.raw && event.raw.pull_request) || null;
    const mergedAt = prRaw && prRaw.merged_at ? prRaw.merged_at : null;
    const status =
      event.state === 'closed' ? (mergedAt ? 'merged' : 'closed') : 'open';
    const prLinkPayload = {
      issue_id: createdId,
      url: event.url,
      number: event.number,
      status,
      merged_at: mergedAt,
      merge_commit_sha: null,
      target_branch_name: event.baseRef || 'main',
    };
    try {
      await vibeApi(
        connector,
        'POST',
        '/v1/pull_request_issues',
        prLinkPayload
      );
      await log('info', 'vibe PR linked to issue', {
        connectorId: effectiveConnectorId,
        issueId: createdId,
        prUrl: event.url,
      });
    } catch (error) {
      state.pullRequestLinkOperations ||= [];
      state.pullRequestLinkOperations.push(
        buildPullRequestLinkOperation({
          id: randomUUID(),
          vibeConnectorId: effectiveConnectorId,
          issueId: createdId,
          payload: prLinkPayload,
          now: Date.now(),
          maxAttempts: RETRY_MAX_ATTEMPTS,
          retryDelay,
          error,
        })
      );
      await persistState();
      await log('warn', 'vibe PR link failed', {
        connectorId: effectiveConnectorId,
        issueId: createdId,
        prUrl: event.url,
        error: errorMessage(error),
        queuedForRetry: true,
      });
    }
  }
  await log('info', 'vibe issue created', {
    connectorId: effectiveConnectorId,
    ruleId: rule.id,
    title: payload.title,
    parentIssueId: payload.parent_issue_id || null,
    tags,
  });
  return body;
}

// Generic Vibe remote API call with access-token auth + one 401 retry.
async function vibeApi(connector, method, path, payload) {
  const config = connector.config || {};
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accessToken = await getVibeAccessToken(connector, attempt > 0);
    const headers = { 'content-type': 'application/json' };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (config.authHeaderName && config.authHeaderValue) {
      headers[String(config.authHeaderName)] = String(config.authHeaderValue);
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();
    // A 401 usually means the cached token just expired; drop it and retry once.
    if (response.status === 401 && attempt === 0 && config.tokenUrl) {
      vibeTokenCache.delete(connector.id);
      await log('warn', 'vibe 401 — refreshing access token', {
        connectorId: connector.id,
      });
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Vibe ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  throw new Error(`Vibe ${method} ${path} failed after token refresh`);
}

function postVibeIssue(connector, payload) {
  return vibeApi(connector, 'POST', '/v1/issues', payload);
}

// Resolve a tag id by name within the project, creating the tag if absent.
// Ids are cached in the connector's tagMap (keyed by lowercased name).
async function resolveVibeTag(connector, projectId, name) {
  const tagMap = (connector.config.tagMap = connector.config.tagMap || {});
  const key = String(name).toLowerCase();
  if (tagMap[key]) return tagMap[key];
  const list = await vibeApi(
    connector,
    'GET',
    `/v1/tags?project_id=${encodeURIComponent(projectId)}`
  );
  const tags = (list && list.tags) || [];
  let tag = tags.find((t) => String(t.name).toLowerCase() === key);
  if (!tag) {
    const created = await vibeApi(connector, 'POST', '/v1/tags', {
      project_id: projectId,
      name: String(name),
      color: '265 60% 55%',
    });
    tag = created && created.data ? created.data : created;
  }
  const id = tag && tag.id;
  if (id) {
    tagMap[key] = id;
    await persistState();
  }
  return id;
}

function attachVibeTag(connector, issueId, tagId) {
  return vibeApi(connector, 'POST', '/v1/issue_tags', {
    issue_id: issueId,
    tag_id: tagId,
  });
}

// Resolve a bearer token for the remote API. Prefer `tokenUrl` — the local Vibe
// Kanban server's /api/auth/token, which owns the refresh token and mints fresh
// access tokens — and fall back to a static `bearerToken`.
async function getVibeAccessToken(connector, forceRefresh) {
  const config = connector.config || {};
  if (!config.tokenUrl) {
    if (config.bearerToken) return config.bearerToken;
    throw new Error('Vibe connector needs tokenUrl or bearerToken');
  }
  const SKEW_MS = 15000;
  const cached = vibeTokenCache.get(connector.id);
  if (!forceRefresh && cached && cached.expMs - SKEW_MS > Date.now()) {
    return cached.token;
  }
  let inflight = vibeTokenInflight.get(connector.id);
  if (!inflight) {
    inflight = fetchVibeAccessToken(connector).finally(() => {
      vibeTokenInflight.delete(connector.id);
    });
    vibeTokenInflight.set(connector.id, inflight);
  }
  return inflight;
}

async function fetchVibeAccessToken(connector) {
  const config = connector.config || {};
  const response = await fetch(String(config.tokenUrl), {
    headers: { accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `token endpoint failed: ${response.status} ${text.slice(0, 200)}`
    );
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('token endpoint returned non-JSON');
  }
  const data = body && body.data ? body.data : body;
  const token = data && data.access_token;
  if (!token) throw new Error('token endpoint returned no access_token');
  const expMs = data.expires_at ? Date.parse(data.expires_at) : jwtExpMs(token);
  vibeTokenCache.set(connector.id, { token, expMs: expMs || 0 });
  return token;
}

function jwtExpMs(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function readBodyJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  return JSON.parse(text);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

async function persistState() {
  await enqueueWrite(STATE_PATH, JSON.stringify(state, null, 2));
}

let logsDirty = false;
let logFlushTimer = null;

// Logs are written from hot poll loops; coalesce the full-file rewrites into at
// most one flush per second instead of one disk write per log line.
function scheduleLogFlush() {
  logsDirty = true;
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    if (!logsDirty) return;
    logsDirty = false;
    enqueueWrite(LOG_PATH, JSON.stringify(logs, null, 2));
  }, 1000);
  if (typeof logFlushTimer.unref === 'function') logFlushTimer.unref();
}

function enqueueWrite(filePath, content) {
  // Keep the chain alive: one rejected write must not permanently stall every
  // future persist. Each task reports and swallows its own error.
  writeQueue = writeQueue.then(async () => {
    try {
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, content);
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      console.error(
        `[persist] write failed for ${filePath}:`,
        errorMessage(error)
      );
    }
  });
  return writeQueue;
}

function log(level, message, meta = {}) {
  const entry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    level,
    message,
    meta,
  };
  logs.unshift(entry);
  logs = logs.slice(0, MAX_LOGS);
  scheduleLogFlush();
  const line = `[${entry.ts}] ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line, meta);
  else console.log(line, meta);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function errorMessage(error) {
  if (!(error instanceof Error)) return String(error);
  // undici's fetch() sets .message to a generic "fetch failed" and hides the
  // real reason (ECONNRESET/ETIMEDOUT/EAI_AGAIN/TLS...) in .cause. Surface it.
  const cause = error.cause?.code || error.cause?.message;
  return cause ? `${error.message} (${cause})` : error.message;
}

// Strip the admin token before a URL is logged so it never lands in logs.json.
function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || '/', 'http://localhost');
    if (url.searchParams.has('token')) url.searchParams.set('token', '***');
    return url.pathname + url.search;
  } catch {
    return '/';
  }
}

function cloneData(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function maxSlackTs(a, b) {
  return Number(a || 0) >= Number(b || 0) ? a : b;
}
