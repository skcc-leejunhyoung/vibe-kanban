import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';

export const workspaceSummaryKeys = {
  all: ['workspace-summaries'] as const,
  byHost: (hostId: string | null = null) =>
    [
      'workspace-summaries',
      getHostRequestScopeQueryKey(hostId),
      'active',
    ] as const,
  // Outside `all` on purpose: approvals, dev servers and creates invalidate
  // `all`, and none of them touches an archived row.
  archived: ['workspace-summaries-archived'] as const,
  archivedByHost: (hostId: string | null = null) =>
    [
      'workspace-summaries-archived',
      getHostRequestScopeQueryKey(hostId),
    ] as const,
};
