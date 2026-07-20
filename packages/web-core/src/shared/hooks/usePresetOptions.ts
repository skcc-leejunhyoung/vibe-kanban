import { useQuery } from '@tanstack/react-query';
import type { BaseCodingAgent, ExecutorConfig } from 'shared/types';
import { agentsApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';

export const presetOptionsKeys = {
  all: ['preset-options'] as const,
  byProfile: (
    hostId: string | null,
    executor: BaseCodingAgent | null,
    variant: string | null
  ) =>
    [
      'preset-options',
      getHostRequestScopeQueryKey(hostId),
      executor,
      variant,
    ] as const,
};

export function usePresetOptions(
  executor: BaseCodingAgent | null,
  variant: string | null,
  hostId: string | null
) {
  return useQuery<ExecutorConfig | null>({
    queryKey: presetOptionsKeys.byProfile(hostId, executor, variant),
    queryFn: () =>
      executor
        ? agentsApi.getPresetOptions({ executor, variant }, hostId)
        : null,
    enabled: !!executor,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
