import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';

export const workspaceSummaryKeys = {
  all: ['workspace-summaries'] as const,
  byHost: (hostId: string | null = null) =>
    [
      'workspace-summaries',
      getHostRequestScopeQueryKey(hostId),
      'all',
    ] as const,
};
