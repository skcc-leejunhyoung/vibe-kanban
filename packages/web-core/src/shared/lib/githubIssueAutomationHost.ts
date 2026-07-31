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
  if (routeHostId) return routeHostId;
  if (runtime === 'local') return null;
  return hosts.find((host) => host.status === 'online')?.id ?? null;
}
