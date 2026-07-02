import type { AddEntryType } from '@/shared/hooks/useConversationHistory/types';

/**
 * Scroll anchoring for background history loading.
 *
 * Older conversation turns stream in AFTER the initial view and are sorted to
 * the TOP of the list (see useConversationHistory: entries are ordered by
 * created_at ascending, so each `historic` batch prepends content above
 * whatever the user is currently looking at). Prepending above the viewport
 * pushes everything down, so without compensation the reader's position drifts
 * on every batch.
 *
 * The fix keeps the viewport visually frozen: measure how much the scrollable
 * content grew during a top-growth commit and add exactly that to scrollTop.
 * When the user is pinned to the bottom this overshoots and the browser clamps
 * back to the bottom, so a single rule covers both the "reading history" and
 * the "following the latest turn" cases.
 */

/** Whether a data update prepends older content above the viewport. */
export function isTopGrowthUpdate(addType: AddEntryType): boolean {
  return addType === 'historic';
}

/**
 * Pixels the content grew during a commit. Only positive growth is
 * compensated — shrink (e.g. a process removed on reset) is left to the
 * browser's own scroll clamping.
 */
export function topGrowthScrollDelta(
  prevScrollHeight: number,
  nextScrollHeight: number
): number {
  const delta = nextScrollHeight - prevScrollHeight;
  return delta > 0 ? delta : 0;
}
