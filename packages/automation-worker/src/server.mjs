import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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
    'ADMIN_TOKEN is required; refusing to start. Set one (e.g. ADMIN_TOKEN=$(openssl rand -hex 32)) and restart.',
  );
  process.exit(1);
}
const HOST = process.env.HOST || '0.0.0.0';
const RULE_TIMEOUT_MS = Number(process.env.RULE_TIMEOUT_MS || 10000);

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

  const title = event.title + ' #' + event.number;
  const cleanBody = (event.body || '').replace(/<!--[^]*?-->/g, '').trim();
  const description = [
    cleanBody || '(no description)',
    '',
    '---',
    'GitHub: ' + event.url,
    'state: ' + event.state + ' | author: ' + (event.user || 'unknown'),
    (event.labels && event.labels.length) ? 'labels: ' + event.labels.join(', ') : null,
    (event.headRef && event.baseRef) ? 'branch: ' + event.headRef + ' -> ' + event.baseRef : null,
  ].filter(function (line) { return line !== null; }).join(String.fromCharCode(10));

  await ctx.actions.vibe.createIssue('vibe-default', {
    title: title,
    description: description,
    sourceKey: event.repo + '#' + event.number,
    parentKey: event.parentNumber ? (event.repo + '#' + event.parentNumber) : null,
    tags: event.type === 'pr' ? ['review'] : [],
  });
}`;

const defaultState = {
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
        intervalSeconds: 120,
        cursorTs: '',
        seenIds: [],
        limit: 50,
        includePullRequests: false,
        reviewPrs: false,
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
      script: defaultGithubRuleScript,
    },
  ],
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
  state.connectors ||= [];
  state.rules ||= [];
  for (const connector of defaultState.connectors) {
    if (!state.connectors.some((item) => item.id === connector.id)) {
      state.connectors.push(structuredClone(connector));
    }
  }
  for (const rule of defaultState.rules) {
    if (!state.rules.some((item) => item.id === rule.id)) {
      state.rules.push(structuredClone(rule));
    }
  }
}

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/' && req.method === 'GET') {
    sendHtml(res, pageHtml());
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

  if (url.pathname === '/api/logs' && req.method === 'GET') {
    sendJson(res, 200, logs);
    return;
  }

  if (url.pathname === '/api/connectors' && req.method === 'POST') {
    const connector = await readBodyJson(req);
    upsertConnector(connector);
    await persistState();
    scheduleAll();
    await log('info', 'connector saved', { id: connector.id, type: connector.type });
    sendState(res);
    return;
  }

  if (url.pathname.startsWith('/api/connectors/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    state.connectors = state.connectors.filter((connector) => connector.id !== id);
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
    await log('info', 'connector updated', { id, patch: Object.keys(patch || {}) });
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

  if (url.pathname === '/api/test-event' && req.method === 'POST') {
    const event = await readBodyJson(req);
    await runRules(event);
    sendJson(res, 200, { ok: true });
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

// Poller-managed runtime state lives in connector.config; preserve it across
// user config saves so a UI/API edit can't roll back the cursor/dedup/parent map.
const RUNTIME_CONFIG_KEYS = ['cursorTs', 'seenIds', 'issueMap', 'tagMap'];

// Credential fields in connector.config. They are replaced with SECRET_MASK in
// every API response so tokens never leave the process in plaintext, and a save
// that echoes the mask back is treated as "unchanged" (see preserveMaskedSecrets).
const SECRET_CONFIG_KEYS = ['token', 'bearerToken', 'authHeaderValue'];
const SECRET_MASK = '__stored__';

function preserveRuntimeConfig(prevConfig, nextConfig) {
  const prev = prevConfig || {};
  for (const key of RUNTIME_CONFIG_KEYS) {
    if (prev[key] !== undefined) nextConfig[key] = prev[key];
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
    preserveRuntimeConfig(state.connectors[index].config, connector.config);
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
    const next = patch.config && typeof patch.config === 'object' ? patch.config : {};
    const prev = connector.config;
    preserveRuntimeConfig(prev, next);
    preserveMaskedSecrets(prev, next);
    connector.config = next;
  }
}

function applyRulePatch(rule, patch) {
  if (!patch || typeof patch !== 'object') throw new Error('invalid patch');
  if ('name' in patch) rule.name = String(patch.name);
  if ('enabled' in patch) rule.enabled = Boolean(patch.enabled);
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
    config: input.config && typeof input.config === 'object' ? input.config : {},
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

  for (const connector of state.connectors) {
    if (!connector.enabled || !POLLABLE_TYPES.has(connector.type)) continue;
    // Guard against a non-numeric config value: Number("abc") is NaN, and
    // setInterval(fn, NaN) coerces the delay to 0, spinning the timer.
    const intervalSeconds = Number(connector.config?.intervalSeconds);
    const safeSeconds = Number.isFinite(intervalSeconds) ? intervalSeconds : 60;
    const intervalMs = Math.max(safeSeconds, 10) * 1000;
    const timer = setInterval(() => {
      pollConnector(connector.id, false).catch((error) => {
        log('error', 'poll failed', { connectorId: connector.id, error: errorMessage(error) });
      });
    }, intervalMs);
    timers.set(connector.id, timer);
    pollConnector(connector.id, false).catch((error) => {
      log('error', 'initial poll failed', { connectorId: connector.id, error: errorMessage(error) });
    });
  }
}

// One in-flight poll per connector. Without this, a poll that outruns its
// interval (or overlaps a manual poll) would let two runs read the same
// cursor/seen snapshot and create duplicate issues before either persists.
const pollInFlight = new Map();

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
  const response = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`Slack API error: ${body.error || response.status}`);

  const messages = Array.isArray(body.messages) ? body.messages.slice().reverse() : [];
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

    event.permalink = await slackPermalink(config.token, config.channelId, message.ts);
    await runRules(event);
    processed += 1;
    latestTs = maxSlackTs(latestTs, message.ts);
  }

  connector.config.cursorTs = latestTs;
  await persistState();
  if (processed > 0) {
    await log('info', 'slack messages processed', { connectorId: connector.id, processed });
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
    'x-github-api-version': '2022-11-28',
    'user-agent': 'vibe-automation-worker',
  };
}

async function githubLogin(connector) {
  const config = connector.config || {};
  if (config.username) return String(config.username);
  const cached = githubLoginCache.get(connector.id);
  if (cached) return cached;
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(/\/+$/, '');
  const response = await fetch(`${apiBase}/user`, { headers: githubHeaders(config.token) });
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
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(/\/+$/, '');
  const fields = numbers
    .map((n) => `i${n}: issue(number: ${n}) { parent { number } }`)
    .join(' ');
  const query = `query { repository(owner: ${JSON.stringify(config.owner)}, name: ${JSON.stringify(config.repo)}) { ${fields} } }`;
  const response = await fetch(`${apiBase}/graphql`, {
    method: 'POST',
    headers: { ...githubHeaders(config.token), 'content-type': 'application/json' },
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
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(/\/+$/, '');
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
    throw new Error(`GitHub search error: ${response.status} ${text.slice(0, 200)}`);
  }
  const body = JSON.parse(text);
  return Array.isArray(body.items) ? body.items : [];
}

// Fetch a PR's head/base branch names (the issues/search payloads omit them).
async function githubPrBranches(connector, number) {
  const config = connector.config || {};
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(/\/+$/, '');
  const response = await fetch(
    `${apiBase}/repos/${config.owner}/${config.repo}/pulls/${number}`,
    { headers: githubHeaders(config.token) },
  );
  if (!response.ok) return null;
  const pr = await response.json();
  return {
    headRef: pr.head && pr.head.ref ? pr.head.ref : null,
    baseRef: pr.base && pr.base.ref ? pr.base.ref : null,
  };
}

async function pollGithub(connector) {
  const config = connector.config || {};
  if (!config.token || !config.owner || !config.repo) {
    throw new Error('GitHub token, owner, and repo are required');
  }
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(/\/+$/, '');
  const filter = String(config.filter || 'assigned');
  const field =
    { assigned: 'assignee', created: 'creator', mentioned: 'mentioned' }[filter] || 'assignee';
  const login = await githubLogin(connector);

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
    if (withSince && config.cursorTs) params.set('since', String(config.cursorTs));
    const response = await fetch(`${issuesUrl}?${params}`, {
      headers: githubHeaders(config.token),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${text.slice(0, 200)}`);
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
  const seeding = !config.backfill && !config.cursorTs && (config.seenIds || []).length === 0;
  const seen = new Set(config.seenIds || []);
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

  const candidates = [];
  const batchIds = new Set();
  for (const issue of Array.isArray(items) ? items : []) {
    if (issue.updated_at && issue.updated_at > latest) latest = issue.updated_at;
    // PRs from the assigned-issue query are dropped unless includePullRequests;
    // PRs surfaced by the review-requested search are always kept.
    if (issue.pull_request && !issue.__reviewPr && !config.includePullRequests) continue;
    const key = String(issue.id);
    if (seen.has(key) || batchIds.has(key)) continue;
    batchIds.add(key);
    candidates.push(issue);
  }

  if (seeding) {
    for (const issue of candidates) seen.add(String(issue.id));
  } else if (candidates.length) {
    // REST omits the parent link; GraphQL has it. Resolve each new issue's
    // parent, then import parents before children so a child can link to its
    // parent's Vibe id within the same batch.
    const parentMap = await githubParentMap(connector, candidates.map((i) => i.number));
    for (const issue of candidates) issue.__parent = parentMap[issue.number] || null;
    for (const issue of orderByParent(candidates)) {
      seen.add(String(issue.id));
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
        labels: (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
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

  connector.config.cursorTs = latest;
  connector.config.seenIds = Array.from(seen).slice(-1000);
  await persistState();
  if (seeding) {
    await log('info', 'github connector seeded (no issues created on first poll)', {
      connectorId: connector.id,
      seeded: seen.size,
    });
  } else if (processed > 0) {
    await log('info', 'github issues processed', { connectorId: connector.id, processed });
  }
  return { ok: true, processed, seeded: seeding ? seen.size : 0, cursorTs: latest };
}

async function slackPermalink(token, channel, messageTs) {
  try {
    const params = new URLSearchParams({ channel, message_ts: messageTs });
    const response = await fetch(`https://slack.com/api/chat.getPermalink?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
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
    }
  }
}

async function runRule(rule, event) {
  // Hand the script a detached copy so a rule can't mutate live state/event.
  // (Hygiene, not a security boundary — vm is not a sandbox.)
  const safeEvent = cloneData(event);
  const context = {
    event: safeEvent,
    ctx: createRuleContext(rule, safeEvent),
    console: {
      log: (...args) => log('info', 'rule console', { ruleId: rule.id, args }),
      warn: (...args) => log('warn', 'rule console', { ruleId: rule.id, args }),
      error: (...args) => log('error', 'rule console', { ruleId: rule.id, args }),
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
    log: (level, message, meta = {}) => log(level, message, { ruleId: rule.id, ...meta }),
    connectors: cloneData(state.connectors),
    actions: {
      vibe: {
        createIssue: (connectorId, input) => createVibeIssue(connectorId, input, event, rule),
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

async function createVibeIssue(connectorId, input, event, rule) {
  const connector = findConnector(connectorId);
  if (!connector.enabled) throw new Error(`Vibe connector is disabled: ${connectorId}`);
  if (connector.type !== 'vibe_kanban') {
    throw new Error(`connector is not vibe_kanban: ${connectorId}`);
  }

  const config = connector.config || {};
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !config.projectId || !config.statusId) {
    throw new Error('Vibe baseUrl, projectId, and statusId are required');
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
  const issueMap = (connector.config.issueMap = connector.config.issueMap || {});
  if (input.parentKey && issueMap[input.parentKey]) {
    payload.parent_issue_id = issueMap[input.parentKey];
  }

  const body = await postVibeIssue(connector, payload);
  const createdId = body && body.data && body.data.id;
  if (input.sourceKey && createdId) {
    issueMap[input.sourceKey] = createdId;
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
          connectorId,
          tag: name,
          error: errorMessage(error),
        });
      }
    }
  }
  await log('info', 'vibe issue created', {
    connectorId,
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
      await log('warn', 'vibe 401 — refreshing access token', { connectorId: connector.id });
      continue;
    }
    if (!response.ok) {
      throw new Error(`Vibe ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`);
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
    `/v1/tags?project_id=${encodeURIComponent(projectId)}`,
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
  return vibeApi(connector, 'POST', '/v1/issue_tags', { issue_id: issueId, tag_id: tagId });
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
    throw new Error(`token endpoint failed: ${response.status} ${text.slice(0, 200)}`);
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
      console.error(`[persist] write failed for ${filePath}:`, errorMessage(error));
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

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Automation Worker</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f6f3; color: #1d1d1b; }
    header { height: 54px; display: flex; align-items: center; justify-content: space-between; padding: 0 18px; border-bottom: 1px solid #d9d8d1; background: #fff; }
    h1 { font-size: 16px; margin: 0; font-weight: 650; }
    main { display: grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 55px); }
    nav { border-right: 1px solid #d9d8d1; padding: 14px; background: #fbfbf8; }
    nav button { width: 100%; display: block; text-align: left; margin-bottom: 8px; padding: 9px 10px; border: 1px solid #d1d0c8; border-radius: 6px; background: #fff; color: inherit; cursor: pointer; }
    nav button.active { border-color: #2b65d9; background: #eef4ff; }
    section { padding: 18px; display: none; }
    section.active { display: block; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    button, input, select, textarea { font: inherit; }
    button.primary { background: #1f5fcf; color: white; border-color: #1f5fcf; }
    button.danger { color: #9d1d20; }
    button { border: 1px solid #c9c7bd; border-radius: 6px; background: #fff; padding: 8px 10px; cursor: pointer; }
    input, select, textarea { box-sizing: border-box; border: 1px solid #c9c7bd; border-radius: 6px; background: #fff; color: inherit; padding: 8px; }
    textarea { width: 100%; min-height: 320px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.45; }
    .grid { display: grid; grid-template-columns: 260px 1fr; gap: 12px; }
    .list { border: 1px solid #d9d8d1; border-radius: 8px; background: #fff; overflow: hidden; }
    .row { padding: 10px; border-bottom: 1px solid #ecebe5; cursor: pointer; }
    .row:last-child { border-bottom: 0; }
    .row.selected { background: #eef4ff; }
    .muted { color: #676762; font-size: 12px; }
    .pill { display: inline-block; border-radius: 999px; padding: 2px 7px; font-size: 11px; border: 1px solid #d0cec4; margin-left: 6px; }
    .enabled { color: #0b6b35; }
    .disabled { color: #8a5a00; }
    .form { display: grid; gap: 8px; }
    .split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-size: 12px; }
    .log { border-bottom: 1px solid #ecebe5; padding: 10px; }
    .error { color: #9d1d20; }
    .warn { color: #8a5a00; }
    @media (prefers-color-scheme: dark) {
      body { background: #181816; color: #ecebe5; }
      header, nav, .list, button, input, select, textarea { background: #20201d; border-color: #3a3933; }
      nav button.active, .row.selected { background: #1e335c; }
      .muted { color: #aaa79b; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Automation Worker</h1>
    <div class="toolbar">
      <input id="token" placeholder="Admin token" style="width: 180px">
      <button onclick="saveToken()">Set token</button>
      <button onclick="load()">Refresh</button>
    </div>
  </header>
  <main>
    <nav>
      <button class="active" onclick="tab('connectors')">Connectors</button>
      <button onclick="tab('rules')">Rules</button>
      <button onclick="tab('logs')">Logs</button>
      <p class="muted">Edit connectors and JavaScript rules here. Changes are saved to /data/state.json.</p>
    </nav>
    <section id="connectors" class="active">
      <div class="toolbar">
        <button class="primary" onclick="newConnector('slack')">Add Slack</button>
        <button class="primary" onclick="newConnector('vibe_kanban')">Add Vibe Kanban</button>
        <button class="primary" onclick="newConnector('github')">Add GitHub</button>
        <button onclick="pollSelected()">Poll selected</button>
      </div>
      <div class="grid">
        <div id="connectorList" class="list"></div>
        <div class="form">
          <div class="split">
            <input id="connectorId" placeholder="id">
            <input id="connectorName" placeholder="name">
          </div>
          <div class="split">
            <select id="connectorType">
              <option value="slack">slack</option>
              <option value="vibe_kanban">vibe_kanban</option>
              <option value="github">github</option>
            </select>
            <select id="connectorEnabled">
              <option value="true">enabled</option>
              <option value="false">disabled</option>
            </select>
          </div>
          <textarea id="connectorConfig" spellcheck="false"></textarea>
          <div class="toolbar">
            <button class="primary" onclick="saveConnector()">Save connector</button>
            <button class="danger" onclick="deleteConnector()">Delete</button>
          </div>
        </div>
      </div>
    </section>
    <section id="rules">
      <div class="toolbar">
        <button class="primary" onclick="newRule()">Add rule</button>
        <button onclick="testEvent()">Run test event</button>
      </div>
      <div class="grid">
        <div id="ruleList" class="list"></div>
        <div class="form">
          <div class="split">
            <input id="ruleId" placeholder="id">
            <input id="ruleName" placeholder="name">
          </div>
          <select id="ruleEnabled">
            <option value="true">enabled</option>
            <option value="false">disabled</option>
          </select>
          <textarea id="ruleScript" spellcheck="false"></textarea>
          <div class="toolbar">
            <button class="primary" onclick="saveRule()">Save rule</button>
            <button class="danger" onclick="deleteRule()">Delete</button>
          </div>
        </div>
      </div>
    </section>
    <section id="logs">
      <div id="logList" class="list"></div>
    </section>
  </main>
  <script>
    let state = { connectors: [], rules: [] };
    let selectedConnector = null;
    let selectedRule = null;
    const tokenInput = document.getElementById('token');
    tokenInput.value = localStorage.getItem('automationToken') || '';

    function headers() {
      const token = localStorage.getItem('automationToken') || '';
      return token ? { authorization: 'Bearer ' + token } : {};
    }
    function saveToken() {
      localStorage.setItem('automationToken', tokenInput.value);
      load();
    }
    function tab(id) {
      document.querySelectorAll('nav button').forEach((button) => button.classList.remove('active'));
      event.target.classList.add('active');
      document.querySelectorAll('section').forEach((section) => section.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      if (id === 'logs') loadLogs();
    }
    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', ...headers(), ...(options.headers || {}) },
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }
    async function load() {
      state = await api('/api/state');
      renderConnectors();
      renderRules();
      loadLogs();
    }
    function renderConnectors() {
      const root = document.getElementById('connectorList');
      root.innerHTML = state.connectors.map((connector) => '<div class="row ' + (connector.id === selectedConnector ? 'selected' : '') + '" data-connector-id="' + escapeHtml(connector.id) + '"><strong>' + escapeHtml(connector.name) + '</strong><span class="pill">' + escapeHtml(connector.type) + '</span><div class="muted ' + (connector.enabled ? 'enabled' : 'disabled') + '">' + (connector.enabled ? 'enabled' : 'disabled') + ' · ' + escapeHtml(connector.id) + '</div></div>').join('');
      if (!selectedConnector && state.connectors[0]) selectConnector(state.connectors[0].id);
    }
    function selectConnector(id) {
      selectedConnector = id;
      const connector = state.connectors.find((item) => item.id === id);
      if (!connector) return;
      document.getElementById('connectorId').value = connector.id;
      document.getElementById('connectorName').value = connector.name;
      document.getElementById('connectorType').value = connector.type;
      document.getElementById('connectorEnabled').value = String(Boolean(connector.enabled));
      document.getElementById('connectorConfig').value = JSON.stringify(connector.config || {}, null, 2);
      renderConnectors();
    }
    function newConnector(type) {
      selectedConnector = null;
      const names = { slack: 'Slack channel polling', vibe_kanban: 'Vibe Kanban issue creator', github: 'GitHub issue poller' };
      const configs = {
        slack: { token: '', channelId: '', intervalSeconds: 60, cursorTs: '0', limit: 25 },
        vibe_kanban: { baseUrl: '', tokenUrl: '', bearerToken: '', projectId: '', statusId: '' },
        github: { token: '', owner: '', repo: '', filter: 'assigned', state: 'open', intervalSeconds: 120, cursorTs: '', seenIds: [], limit: 50, includePullRequests: false, reviewPrs: false, backfill: false },
      };
      document.getElementById('connectorId').value = type + '-' + Math.random().toString(16).slice(2, 8);
      document.getElementById('connectorName').value = names[type] || type;
      document.getElementById('connectorType').value = type;
      document.getElementById('connectorEnabled').value = 'false';
      document.getElementById('connectorConfig').value = JSON.stringify(configs[type] || {}, null, 2);
    }
    async function saveConnector() {
      const connector = {
        id: document.getElementById('connectorId').value.trim(),
        name: document.getElementById('connectorName').value.trim(),
        type: document.getElementById('connectorType').value,
        enabled: document.getElementById('connectorEnabled').value === 'true',
        config: JSON.parse(document.getElementById('connectorConfig').value || '{}'),
      };
      state = await api('/api/connectors', { method: 'POST', body: JSON.stringify(connector) });
      selectedConnector = connector.id;
      renderConnectors();
    }
    async function deleteConnector() {
      if (!selectedConnector || !confirm('Delete connector?')) return;
      state = await api('/api/connectors/' + encodeURIComponent(selectedConnector), { method: 'DELETE' });
      selectedConnector = null;
      renderConnectors();
    }
    async function pollSelected() {
      if (!selectedConnector) return;
      await api('/api/poll/' + encodeURIComponent(selectedConnector), { method: 'POST' });
      await load();
    }
    function renderRules() {
      const root = document.getElementById('ruleList');
      root.innerHTML = state.rules.map((rule) => '<div class="row ' + (rule.id === selectedRule ? 'selected' : '') + '" data-rule-id="' + escapeHtml(rule.id) + '"><strong>' + escapeHtml(rule.name) + '</strong><div class="muted ' + (rule.enabled ? 'enabled' : 'disabled') + '">' + (rule.enabled ? 'enabled' : 'disabled') + ' · ' + escapeHtml(rule.id) + '</div></div>').join('');
      if (!selectedRule && state.rules[0]) selectRule(state.rules[0].id);
    }
    function selectRule(id) {
      selectedRule = id;
      const rule = state.rules.find((item) => item.id === id);
      if (!rule) return;
      document.getElementById('ruleId').value = rule.id;
      document.getElementById('ruleName').value = rule.name;
      document.getElementById('ruleEnabled').value = String(Boolean(rule.enabled));
      document.getElementById('ruleScript').value = rule.script || '';
      renderRules();
    }
    function newRule() {
      selectedRule = null;
      document.getElementById('ruleId').value = 'rule-' + Math.random().toString(16).slice(2, 8);
      document.getElementById('ruleName').value = 'Untitled rule';
      document.getElementById('ruleEnabled').value = 'true';
      document.getElementById('ruleScript').value = 'async function handle(event, ctx) {\\n  ctx.log("info", "event received", { event });\\n}';
    }
    async function saveRule() {
      const rule = {
        id: document.getElementById('ruleId').value.trim(),
        name: document.getElementById('ruleName').value.trim(),
        enabled: document.getElementById('ruleEnabled').value === 'true',
        script: document.getElementById('ruleScript').value,
      };
      state = await api('/api/rules', { method: 'POST', body: JSON.stringify(rule) });
      selectedRule = rule.id;
      renderRules();
    }
    async function deleteRule() {
      if (!selectedRule || !confirm('Delete rule?')) return;
      state = await api('/api/rules/' + encodeURIComponent(selectedRule), { method: 'DELETE' });
      selectedRule = null;
      renderRules();
    }
    async function testEvent() {
      await api('/api/test-event', {
        method: 'POST',
        body: JSON.stringify({
          source: 'slack',
          type: 'message',
          connectorId: 'manual-test',
          channelId: 'test',
          text: '#issue Test issue | Created from the test event button',
          ts: String(Date.now() / 1000),
        }),
      });
      await loadLogs();
    }
    async function loadLogs() {
      const items = await api('/api/logs');
      document.getElementById('logList').innerHTML = items.map((item) => '<div class="log"><strong class="' + item.level + '">' + item.level.toUpperCase() + '</strong> <span class="muted">' + item.ts + '</span><div>' + escapeHtml(item.message) + '</div><pre>' + escapeHtml(JSON.stringify(item.meta || {}, null, 2)) + '</pre></div>').join('');
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    document.getElementById('connectorList').addEventListener('click', (clickEvent) => {
      const row = clickEvent.target.closest('[data-connector-id]');
      if (row) selectConnector(row.getAttribute('data-connector-id'));
    });
    document.getElementById('ruleList').addEventListener('click', (clickEvent) => {
      const row = clickEvent.target.closest('[data-rule-id]');
      if (row) selectRule(row.getAttribute('data-rule-id'));
    });
    load().catch((error) => alert(error.message));
  </script>
</body>
</html>`;
}
