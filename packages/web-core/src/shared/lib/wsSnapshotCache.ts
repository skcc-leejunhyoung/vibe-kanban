/**
 * Last-known snapshots of JSON-patch WebSocket streams, keyed by endpoint.
 *
 * A stream's endpoint fully identifies its data (it embeds host scoping and
 * query params), and the server replays a fresh snapshot on every (re)connect.
 * Saving the last materialized state lets a returning consumer paint the
 * previous snapshot immediately — stale-while-revalidate — instead of blanking
 * until the replay arrives. Entries are only ever read by the exact endpoint
 * that produced them, so staleness self-heals on the next server snapshot.
 *
 * Only opt streams in whose server replay fully supersedes a stale snapshot
 * (root-level replace + guaranteed Ready). The diff stream fails both, so it
 * stays uncached.
 *
 * LRU order is save-order only: consumers re-save on every teardown, so a
 * read-time bump would be unobservable.
 */

const MAX_SNAPSHOTS = 16;

const snapshots = new Map<string, object>();

export function wsSnapshotKey(
  endpoint: string | undefined,
  hostId: string | null
): string | undefined {
  return endpoint === undefined
    ? undefined
    : JSON.stringify([hostId, endpoint]);
}

export function getWsSnapshot<T extends object>(
  endpoint: string | undefined
): T | undefined {
  if (!endpoint) return undefined;
  return snapshots.get(endpoint) as T | undefined;
}

export function saveWsSnapshot(endpoint: string, value: object): void {
  snapshots.delete(endpoint);
  snapshots.set(endpoint, value);
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

export function clearWsSnapshots(): void {
  snapshots.clear();
}
