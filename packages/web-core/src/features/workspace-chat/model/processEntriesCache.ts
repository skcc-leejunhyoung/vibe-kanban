import type { PatchType } from 'shared/types';

/**
 * Conversation entries of FINISHED execution processes, keyed by process id.
 *
 * A finished process's normalized logs are immutable on the server, so its
 * resolved entries can be reused across workspace/session navigations instead
 * of re-opening a WebSocket and re-streaming the whole history each time the
 * conversation remounts. This is what makes returning to a previously viewed
 * conversation instant.
 *
 * Processes deleted on the server simply disappear from the process list, so
 * their orphaned entries are never requested again and age out via the LRU.
 *
 * `hostId` must be the host the entries were fetched from (captured when the
 * load started), NOT read ambiently at completion time — streams can resolve
 * after the user has navigated to another host.
 */

/**
 * Total rough byte budget (serialized size; in-memory objects run larger, so
 * the budget is kept modest).
 */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Processes whose entries serialize larger than this are not cached. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
/** Remembered oversized/unserializable processes, so the (expensive) size
 * measurement is not repeated on every revisit. */
const MAX_REJECTED_IDS = 512;

/**
 * Match the server replay cache's settling window. Process status is updated
 * before the JSONL writer necessarily finishes draining, so replay results
 * from younger processes may be truncated and must remain self-healing.
 */
export const PROCESS_ENTRIES_CACHE_MIN_AGE_MS = 60_000;

interface CacheEntry {
  entries: PatchType[];
  bytes: number;
}

// Map preserves insertion order → delete+set keeps LRU order.
const cache = new Map<string, CacheEntry>();
const rejected = new Set<string>();
let totalBytes = 0;

function cacheKey(hostId: string | null, processId: string): string {
  // Process ids are UUIDs, but scope by host anyway so multi-host browsing
  // can never serve another host's data.
  return `${hostId ?? 'local'}:${processId}`;
}

export function hasStableCompletedLog(
  completedAt: string | null,
  nowMs = Date.now()
): boolean {
  if (!completedAt) return false;
  const completedAtMs = Date.parse(completedAt);
  return (
    Number.isFinite(completedAtMs) &&
    nowMs - completedAtMs > PROCESS_ENTRIES_CACHE_MIN_AGE_MS
  );
}

/**
 * Serialized size with early abort: entries are measured one by one and the
 * scan stops as soon as the budget is exceeded, so a huge conversation costs
 * at most MAX_ENTRY_BYTES of stringify work (once — see `rejected`).
 * Returns null when the entries are uncacheable (too large / unserializable).
 */
function measureBytes(entries: PatchType[]): number | null {
  let total = 0;
  try {
    for (const entry of entries) {
      total += JSON.stringify(entry).length;
      if (total > MAX_ENTRY_BYTES) return null;
    }
  } catch {
    return null;
  }
  return total;
}

export function getCachedProcessEntries(
  hostId: string | null,
  processId: string
): PatchType[] | undefined {
  const key = cacheKey(hostId, processId);
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit.entries;
}

export function setCachedProcessEntries(
  hostId: string | null,
  processId: string,
  entries: PatchType[]
): void {
  const key = cacheKey(hostId, processId);
  if (rejected.has(key)) return;

  const bytes = measureBytes(entries);
  if (bytes === null) {
    if (rejected.size >= MAX_REJECTED_IDS) rejected.clear();
    rejected.add(key);
    return;
  }

  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    totalBytes -= existing.bytes;
  }
  while (totalBytes + bytes > MAX_TOTAL_BYTES && cache.size > 0) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    totalBytes -= oldest?.bytes ?? 0;
  }
  cache.set(key, { entries, bytes });
  totalBytes += bytes;
}

/** Test-only helpers. */
export function clearProcessEntriesCache(): void {
  cache.clear();
  rejected.clear();
  totalBytes = 0;
}

export function processEntriesCacheStats(): { size: number; bytes: number } {
  return { size: cache.size, bytes: totalBytes };
}
