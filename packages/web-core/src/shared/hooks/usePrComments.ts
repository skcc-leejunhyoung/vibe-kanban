import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { PrCommentsResponse } from 'shared/types';

export const prCommentsKeys = {
  all: ['prComments'] as const,
  byAttempt: (
    workspaceId: string | undefined,
    repoId: string | undefined,
    prNumber?: number
  ) => ['prComments', workspaceId, repoId, prNumber] as const,
};

type Options = {
  enabled?: boolean;
  prNumber?: number;
};

export function usePrComments(
  workspaceId?: string,
  repoId?: string,
  opts?: Options
) {
  const enabled = (opts?.enabled ?? true) && !!workspaceId && !!repoId;

  return useQuery<PrCommentsResponse>({
    queryKey: prCommentsKeys.byAttempt(workspaceId, repoId, opts?.prNumber),
    queryFn: () =>
      workspacesApi.getPrComments(workspaceId!, repoId!, opts?.prNumber),
    enabled,
    staleTime: 30_000, // Cache for 30s - comments don't change frequently
    retry: 2,
  });
}
