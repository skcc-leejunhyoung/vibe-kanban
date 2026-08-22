import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ExecutorConfig, RepoWithTargetBranch } from 'shared/types';
import { workspacesApi } from '@/shared/lib/api';
import { useExecutionProcesses } from '@/shared/hooks/useExecutionProcesses';
import { getLatestConfigFromProcesses } from '@/shared/lib/executor';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';

interface UseWorkspaceCreateDefaultsOptions {
  sourceWorkspaceId: string | null;
  enabled: boolean;
}

interface WorkspaceCreateDefaultsData {
  repos: RepoWithTargetBranch[];
  sourceSessionId: string | undefined;
  sourceSessionExecutor: ExecutorConfig['executor'] | null;
}

interface UseWorkspaceCreateDefaultsResult {
  preferredRepos: RepoWithTargetBranch[];
  preferredExecutorConfig: ExecutorConfig | null;
  hasResolvedPreferredRepos: boolean;
}

export const workspaceCreateDefaultsKeys = {
  byWorkspace: (workspaceId: string | null, hostId: string | null = null) =>
    [
      'workspaceCreateDefaults',
      workspaceId,
      getHostRequestScopeQueryKey(hostId),
    ] as const,
};

export function useWorkspaceCreateDefaults({
  sourceWorkspaceId,
  enabled,
}: UseWorkspaceCreateDefaultsOptions): UseWorkspaceCreateDefaultsResult {
  const hostId = useHostId();
  const queryEnabled = enabled && !!sourceWorkspaceId;

  const { data, status } = useQuery<WorkspaceCreateDefaultsData>({
    queryKey: workspaceCreateDefaultsKeys.byWorkspace(
      sourceWorkspaceId,
      hostId
    ),
    enabled: queryEnabled,
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async () => {
      const [repos, workspaceWithSession] = await Promise.all([
        workspacesApi.getRepos(sourceWorkspaceId!, hostId),
        workspacesApi.getWithSession(sourceWorkspaceId!, hostId),
      ]);

      const result = {
        repos,
        sourceSessionId: workspaceWithSession.session?.id ?? undefined,
        sourceSessionExecutor:
          (workspaceWithSession.session
            ?.executor as ExecutorConfig['executor']) ?? null,
      };
      return result;
    },
  });

  const { executionProcesses } = useExecutionProcesses(data?.sourceSessionId);

  const preferredExecutorConfig = useMemo(() => {
    const fromProcesses = getLatestConfigFromProcesses(executionProcesses);
    if (fromProcesses) return fromProcesses;
    if (data?.sourceSessionExecutor) {
      return { executor: data.sourceSessionExecutor };
    }
    return null;
  }, [executionProcesses, data?.sourceSessionExecutor]);

  return {
    preferredRepos: data?.repos ?? [],
    preferredExecutorConfig,
    hasResolvedPreferredRepos: !queryEnabled || status !== 'pending',
  };
}
