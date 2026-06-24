// Decide whether the root redirect can reuse the user's last-selected
// org+project instead of running the blocking remote first-project lookup.
//
// On a cold PWA start the Electric projects collection has not synced yet, so
// the normal lookup blocks for up to ~3s (org fetch + Electric ready timeout)
// before it can pick a project. A warm Safari tab keeps that collection cached,
// which is why the PWA is the one that feels slow. When we already have a saved
// selection we can skip the wait:
//   - cold collection  → navigate optimistically (verified on a later warm load)
//   - warm collection  → verify the saved project still exists; if it's gone,
//                         fall back to the full lookup so we don't strand the
//                         user on a deleted project.

export interface SavedProjectInput {
  /** Last selected org id from ui preferences (null/'' if none). */
  savedOrgId: string | null;
  /** Last selected project id from ui preferences (null/'' if none). */
  savedProjectId: string | null;
  /** Whether the Electric projects collection has finished its initial sync. */
  collectionReady: boolean;
  /** When the collection is ready, whether it still contains the saved project. */
  savedProjectExists: boolean;
}

export function shouldUseSavedProject(input: SavedProjectInput): boolean {
  if (!input.savedOrgId || !input.savedProjectId) return false;
  // Cold collection (typical PWA cold start): don't wait for the sync, trust
  // the saved selection.
  if (!input.collectionReady) return true;
  // Warm collection: only reuse the saved project if it still exists.
  return input.savedProjectExists;
}
