import type { LinkedWorkspace } from '@/shared/dialogs/command-bar/selectLinkedWorkspace';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { normalizeGitHubPullRequestUrl } from './pullRequestUrl';

function normalizePullRequestUrl(url: string): string {
  return (
    normalizeGitHubPullRequestUrl(url)?.toLowerCase() ??
    url.trim().replace(/\/+$/, '').toLowerCase()
  );
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

/**
 * Merge issue-mapped cloud workspace rows with PR-linked local summaries,
 * deduped per workspace. Both sides address this machine as `null` (cloud
 * rows are folded where they enter the app), so keys compare directly.
 */
export function mergeMappedPullRequestWorkspaces(
  pullRequestUrl: string,
  mappedWorkspaces: LinkedWorkspace[],
  localWorkspaces: SidebarWorkspace[]
): LinkedWorkspace[] {
  const keyOf = (hostId: string | null, workspaceId: string) =>
    `${hostId}:${workspaceId}`;
  const merged = new Map<string, LinkedWorkspace>();
  for (const workspace of mappedWorkspaces) {
    merged.set(
      keyOf(workspace.host_id, workspace.local_workspace_id),
      workspace
    );
  }
  for (const workspace of findLocalPullRequestWorkspaces(
    pullRequestUrl,
    localWorkspaces
  )) {
    const hostId = workspace.hostId ?? null;
    const key = keyOf(hostId, workspace.id);
    if (merged.has(key)) continue;
    merged.set(key, {
      id: key,
      host_id: hostId,
      local_workspace_id: workspace.id,
      name: workspace.name,
      archived: workspace.isArchived ?? false,
      updated_at: workspace.updatedAt,
    });
  }
  return [...merged.values()];
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
