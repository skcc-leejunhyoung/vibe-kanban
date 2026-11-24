export function isTextEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      !!target.closest('input, textarea, select, [role="dialog"]'))
  );
}

/** Neighbor of `currentId` in `ids`, or null at either end / when absent. */
export function adjacentIssueId(
  ids: readonly string[],
  currentId: string,
  direction: -1 | 1
): string | null {
  const index = ids.indexOf(currentId);
  if (index < 0) return null;
  return ids[index + direction] ?? null;
}
