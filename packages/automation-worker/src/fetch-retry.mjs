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
