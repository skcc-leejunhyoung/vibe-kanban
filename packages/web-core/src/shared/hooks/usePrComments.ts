import { useQuery } from '@tanstack/react-query';
import { issuePrsApi, workspacesApi } from '@/shared/lib/api';
import type { PrCommentsResponse } from 'shared/types';

export const prCommentsKeys = {
  all: ['prComments'] as const,
  byAttempt: (
    workspaceId: string | undefined,
    repoId: string | undefined,
    prNumber?: number,
    prUrl?: string
  ) => ['prComments', workspaceId, repoId, prNumber, prUrl] as const,
};

type Options = {
  enabled?: boolean;
  prNumber?: number;
  prUrl?: string;
};

export function usePrComments(
  workspaceId?: string,
  repoId?: string,
  opts?: Options
) {
  const hasWorkspaceSource = !!workspaceId && !!repoId;
  const hasUrlSource = !!opts?.prUrl && opts.prNumber != null;
  const enabled =
    (opts?.enabled ?? true) && (hasWorkspaceSource || hasUrlSource);

  return useQuery<PrCommentsResponse>({
    queryKey: prCommentsKeys.byAttempt(
      workspaceId,
      repoId,
      opts?.prNumber,
      opts?.prUrl
    ),
    queryFn: () => {
      if (hasWorkspaceSource) {
        return workspacesApi.getPrComments(
          workspaceId!,
          repoId!,
          opts?.prNumber
        );
      }
      return issuePrsApi.getPrComments(opts!.prUrl!, opts!.prNumber!);
    },
    enabled,
    staleTime: 30_000, // Cache for 30s - comments don't change frequently
    retry: 2,
  });
}
