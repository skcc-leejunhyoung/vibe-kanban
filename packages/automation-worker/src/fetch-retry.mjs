import { createHash } from 'node:crypto';

// The host's network path stalls for ~10s now and then (container and host
// alike, every destination at once). Calls caught in a stall fail with undici
// connect timeouts or pooled sockets closed mid-request; a short backoff retry
// absorbs them. The per-attempt timeout replaces undici's 300s headers timeout,
// which otherwise holds the whole poll for five minutes.

// The request was never sent, so any method can be replayed.
const CONNECT_ERRORS = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);
// The request may have reached the server; replay only when that is harmless.
const IN_FLIGHT_ERRORS = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'TimeoutError',
]);

// Every PATCH this worker sends sets absolute values, and its GraphQL calls are
// queries or idempotent project mutations. Plain POSTs create rows.
function replaySafe(url, method) {
  return method !== 'POST' || new URL(url).pathname.endsWith('/graphql');
}

export async function fetchWithRetry(
  url,
  options = {},
  {
    fetchImpl = globalThis.fetch,
    attempts = 3,
    timeoutMs = 30_000,
    backoffMs = [1_000, 3_000],
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}
) {
  const method = String(options.method || 'GET').toUpperCase();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchImpl(url, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const code =
        error?.name === 'TimeoutError' ? error.name : error?.cause?.code;
      const retryable =
        CONNECT_ERRORS.has(code) ||
        (IN_FLIGHT_ERRORS.has(code) && replaySafe(url, method));
      if (!retryable || attempt >= attempts) throw error;
      await sleep(backoffMs[Math.min(attempt, backoffMs.length) - 1]);
    }
  }
}

// GitHub answers a conditional GET for an unchanged resource with 304, and a
// 304 does not count against the REST rate limit. Each issue-sync round
// re-reads mostly unchanged issues, so remember the ETag and body of every
// GitHub GET (requests built by githubHeaders carry the API-version header)
// and replay the body on 304. Other requests pass through untouched.
// ponytail: in-memory LRU of maxEntries bodies, empty after a restart.
export function withGithubConditionalGet(fetchImpl, { maxEntries = 1000 } = {}) {
  const cache = new Map();
  return async (url, options = {}) => {
    const headers = options.headers || {};
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET' || !headers['x-github-api-version'])
      return fetchImpl(url, options);
    const auth = createHash('sha256')
      .update(String(headers.authorization || ''))
      .digest('hex');
    const key = `${auth} ${headers.accept || ''} ${url}`;
    const cached = cache.get(key);
    const response = await fetchImpl(
      url,
      cached
        ? { ...options, headers: { ...headers, 'if-none-match': cached.etag } }
        : options
    );
    cache.delete(key);
    if (response.status === 304 && cached) {
      cache.set(key, cached);
      return new Response(cached.body, { status: 200 });
    }
    const etag = response.status === 200 && response.headers?.get('etag');
    if (!etag) return response;
    const body = await response.text();
    cache.set(key, { etag, body });
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return new Response(body, { status: 200 });
  };
}
