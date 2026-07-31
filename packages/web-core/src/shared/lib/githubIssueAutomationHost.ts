import type { AppRuntime } from '@/shared/hooks/useAppRuntime';

export interface GithubIssueAutomationHost {
  id: string;
  status: string;
}

export function resolveGithubIssueAutomationHostId(
  runtime: AppRuntime,
  routeHostId: string | null,
  hosts: GithubIssueAutomationHost[]
): string | null {
  if (runtime === 'local') return null;
  if (
    routeHostId &&
    hosts.some((host) => host.id === routeHostId && host.status === 'online')
  ) {
    return routeHostId;
  }
  return null;
}
