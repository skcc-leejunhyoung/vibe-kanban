import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';

function normalizePullRequestUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

export function findLocalPullRequestWorkspaces(
  pullRequestUrl: string,
  workspaces: SidebarWorkspace[]
): SidebarWorkspace[] {
  const normalizedUrl = normalizePullRequestUrl(pullRequestUrl);
  return workspaces.filter(
    (workspace) =>
      workspace.prUrl !== undefined &&
      normalizePullRequestUrl(workspace.prUrl) === normalizedUrl
  );
}

export function hasPullRequestWorkspace(
  pullRequestUrl: string,
  localWorkspaces: SidebarWorkspace[],
  mappedIssueIds: Set<string>,
  remoteWorkspaces: Array<{
    issue_id: string | null;
    local_workspace_id: string | null;
  }>
): boolean {
  return (
    findLocalPullRequestWorkspaces(pullRequestUrl, localWorkspaces).length >
      0 ||
    remoteWorkspaces.some(
      (workspace) =>
        workspace.issue_id !== null &&
        workspace.local_workspace_id !== null &&
        mappedIssueIds.has(workspace.issue_id)
    )
  );
}
