import type { Diff } from 'shared/types';

/**
 * Stale-while-reconnecting hold logic for the diff stream.
 *
 * The underlying WS hook (useJsonPatchWsStream) clears its accumulated data on
 * every reconnect — a retryNonce-driven effect re-run wipes `data` back to
 * empty before the new socket rebuilds it. For the Changes view that means the
 * whole diff list unmounts and refills on each reconnect (tab switch, PWA
 * resume, network blip), collapsing scroll height to zero and flashing.
 *
 * The server always re-sends a full `replace_repo_diffs` snapshot as the first
 * message on a fresh connection (see crates/services diff_stream.rs), so the
 * fresh data is authoritative the moment `isInitialized` flips true again. Until
 * then we keep serving the last known diffs BY STABLE REFERENCE, so downstream
 * memos don't churn and the viewport holds.
 */

const EMPTY_DIFFS: Diff[] = [];

export interface DiffHoldState {
  /** Last diffs served while initialized (kept to bridge reconnect gaps). */
  lastKnown: Diff[];
  /** Workspace the cache belongs to, so a switch never bleeds old diffs. */
  workspaceId: string | null;
}

export const initialDiffHoldState = (
  workspaceId: string | null
): DiffHoldState => ({
  lastKnown: EMPTY_DIFFS,
  workspaceId,
});

export interface DiffHoldInput {
  workspaceId: string | null;
  /** Whether the current socket has received its initial snapshot (Ready). */
  isInitialized: boolean;
  /** Diffs derived from the current (possibly mid-reconnect) stream data. */
  derived: Diff[];
}

/**
 * Decide which diffs to serve and carry the hold state forward.
 * Pure: the hook stores `state` in a ref and passes it back next render.
 */
export function selectHeldDiffs(
  prev: DiffHoldState,
  input: DiffHoldInput
): { diffs: Diff[]; state: DiffHoldState } {
  // A workspace switch drops the cache immediately: we must never show the
  // previous workspace's diffs while the new stream initializes.
  const carriedLastKnown =
    prev.workspaceId === input.workspaceId ? prev.lastKnown : EMPTY_DIFFS;

  if (input.isInitialized) {
    // Fresh snapshot is authoritative; remember it for the next reconnect gap.
    return {
      diffs: input.derived,
      state: { lastKnown: input.derived, workspaceId: input.workspaceId },
    };
  }

  // Reconnecting (or first connect): hold the last known diffs by stable
  // reference so the Changes view neither collapses nor refills.
  return {
    diffs: carriedLastKnown,
    state: { lastKnown: carriedLastKnown, workspaceId: input.workspaceId },
  };
}
