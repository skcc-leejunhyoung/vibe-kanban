export const isWorkspaceVisibleOnIssueCard = (
  workspace: { archived: boolean; local_workspace_id: string | null },
  locallyArchivedWorkspaceIds: ReadonlySet<string>
) =>
  !workspace.archived &&
  !!workspace.local_workspace_id &&
  !locallyArchivedWorkspaceIds.has(workspace.local_workspace_id);
