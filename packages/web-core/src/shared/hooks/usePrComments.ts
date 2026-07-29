import { useQuery } from '@tanstack/react-query';
import { issuePrsApi, workspacesApi } from '@/shared/lib/api';
import type { PrCommentsResponse } from 'shared/types';

export const prCommentsKeys = {
  all: ['prComments'] as const,
  byWorkspace: (
    workspaceId: string | undefined,
    repoId: string | undefined,
    prNumber?: number
  ) => ['prComments', 'workspace', workspaceId, repoId, prNumber] as const,
  byUrl: (prUrl: string, prNumber: number) =>
    ['prComments', 'url', prUrl, prNumber] as const,
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
    queryKey: prCommentsKeys.byWorkspace(workspaceId, repoId, opts?.prNumber),
    queryFn: () =>
      workspacesApi.getPrComments(workspaceId!, repoId!, opts?.prNumber),
    enabled,
    staleTime: 30_000, // Cache for 30s - comments don't change frequently
    retry: 2,
  });
}

export function usePrCommentsByUrl(
  prUrl: string,
  prNumber: number,
  enabled = true
) {
  return useQuery<PrCommentsResponse>({
    queryKey: prCommentsKeys.byUrl(prUrl, prNumber),
    queryFn: () => issuePrsApi.getPrComments(prUrl, prNumber),
    enabled,
    staleTime: 30_000,
    retry: 2,
  });
}
