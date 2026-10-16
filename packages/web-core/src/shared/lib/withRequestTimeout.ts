export const REQUEST_TIMEOUT_MS = 15_000;

/** Bound the entire read, including token lookup and response body parsing. */
export async function withRequestTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timeout = globalThis.setTimeout(
    () => controller.abort(new Error('Request timed out')),
    REQUEST_TIMEOUT_MS
  );
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(combined.reason);
        combined.addEventListener('abort', onAbort, { once: true });
      }),
      request(combined),
    ]);
  } finally {
    globalThis.clearTimeout(timeout);
    combined.removeEventListener('abort', onAbort);
  }
}
