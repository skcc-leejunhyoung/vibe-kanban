interface CommandBarIssueContext {
  explicitIssueIds?: string[];
  selectedIssueIds: ReadonlySet<string>;
  routeIssueId?: string;
  cursorIssueId: string | null;
}

export function resolveCommandBarIssueIds({
  explicitIssueIds,
  selectedIssueIds,
  routeIssueId,
  cursorIssueId,
}: CommandBarIssueContext): string[] {
  if (explicitIssueIds) return explicitIssueIds;
  if (selectedIssueIds.size > 0) return [...selectedIssueIds];
  if (routeIssueId) return [routeIssueId];
  return cursorIssueId ? [cursorIssueId] : [];
}
