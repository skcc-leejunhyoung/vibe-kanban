import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HostAppearance } from 'shared/types';
import { configApi } from '@/shared/lib/api';
import {
  getHostRequestScopeQueryKey,
  getHostUserSystemQueryKey,
} from '@/shared/lib/hostRequestScope';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useUserSystemController } from '@/shared/hooks/useUserSystemController';

/**
 * Config and executor profiles of one explicit host (`null` = this machine on
 * the local web). The load, the save and the cache entry are all bound to
 * that host, never to whichever host the document or the active pane is on.
 */
export function useHostUserSystem(
  hostId: string | null,
  options: { enabled?: boolean } = {}
) {
  const runtime = useAppRuntime();
  const queryClient = useQueryClient();
  const { isLoaded, isSignedIn } = useAuth();
  const queryKey = useMemo(
    () => getHostUserSystemQueryKey(runtime, hostId),
    [runtime, hostId]
  );
  const load = useCallback(() => configApi.getConfig(hostId), [hostId]);
  const save = useCallback(
    async (
      config: Parameters<typeof configApi.saveConfig>[0],
      revision: string
    ) => {
      const saved = await configApi.saveConfig(config, revision, hostId);
      // The sidebar tints this host's rows from its own copy of the colour
      // (see useHostPrimaryColors): keep that copy, and only it, in step.
      queryClient.setQueryData<HostAppearance>(
        [
          'user-system',
          'workspace-host-primary-color',
          getHostRequestScopeQueryKey(hostId),
        ],
        (shown) =>
          shown && { ...shown, primary_color: saved.config.primary_color }
      );
      return saved;
    },
    [hostId, queryClient]
  );
  return useUserSystemController({
    queryKey,
    load,
    save,
    // The remote web reaches hosts only through the signed-in account.
    enabled:
      (options.enabled ?? true) &&
      (runtime === 'local' || (!!isLoaded && !!isSignedIn && hostId !== null)),
    loading: runtime === 'remote' && !isLoaded ? true : undefined,
  });
}
