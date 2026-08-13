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
