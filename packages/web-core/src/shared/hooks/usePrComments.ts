import { useQuery } from '@tanstack/react-query';
import { issuePrsApi, workspacesApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { getGitHubPullRequestComments } from '@/shared/lib/remoteApi';
import type { PrCommentsResponse } from 'shared/types';

export const prCommentsKeys = {
  all: ['prComments'] as const,
  byWorkspace: (
    workspaceId: string | undefined,
    repoId: string | undefined,
    prNumber?: number,
    hostId: string | null = null
  ) =>
    [
      'prComments',
      'workspace',
      workspaceId,
      repoId,
      prNumber,
      getHostRequestScopeQueryKey(hostId),
    ] as const,
  byUrl: (
    prUrl: string,
    prNumber: number,
    dataSource: 'host' | 'github',
    hostId: string | null
  ) =>
    [
      'prComments',
      'url',
      prUrl,
      prNumber,
      dataSource === 'github' ? 'github' : getHostRequestScopeQueryKey(hostId),
    ] as const,
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
  const hostId = useHostId();
  const enabled = (opts?.enabled ?? true) && !!workspaceId && !!repoId;

  return useQuery<PrCommentsResponse>({
    queryKey: prCommentsKeys.byWorkspace(
      workspaceId,
      repoId,
      opts?.prNumber,
      hostId
    ),
    queryFn: () =>
      workspacesApi.getPrComments(
        workspaceId!,
        repoId!,
        opts?.prNumber,
        hostId
      ),
    enabled,
    staleTime: 30_000, // Cache for 30s - comments don't change frequently
    retry: 2,
  });
}

export function usePrCommentsByUrl(
  prUrl: string,
  prNumber: number,
  options: {
    enabled?: boolean;
    dataSource?: 'host' | 'github';
    hostId?: string | null;
  } = {}
) {
  const routeHostId = useHostId();
  const hostId = options.hostId === undefined ? routeHostId : options.hostId;
  const dataSource = options.dataSource ?? 'host';
  return useQuery<PrCommentsResponse>({
    queryKey: prCommentsKeys.byUrl(prUrl, prNumber, dataSource, hostId),
    queryFn: () =>
      dataSource === 'github'
        ? getGitHubPullRequestComments(prUrl)
        : issuePrsApi.getPrComments(prUrl, prNumber, hostId),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
    retry: 2,
  });
}
