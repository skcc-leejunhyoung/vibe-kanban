import { type ReactNode, useCallback, useMemo } from 'react';
import { configApi } from '@/shared/lib/api';
import { useUserSystemController } from '@/shared/hooks/useUserSystemController';
import { UserSystemContext, useUserSystem } from '@/shared/hooks/useUserSystem';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { shouldOverrideLocalUserSystem } from '@/shared/lib/hostRequestScope';

/**
 * Local routes normally inherit the app-wide local machine config. A route
 * targeting a paired host gets its own immutable user-system scope instead.
 * Self-host routes collapse to null in HostIdProvider and keep the local value.
 *
 * The provider is always mounted with the same tree shape: only the context
 * VALUE switches with the host. Swapping a wrapper component in and out on
 * host changes would remount the entire subtree (the whole app shell), which
 * reads as a full page refresh whenever focus moves to a pane whose workspace
 * lives on another host.
 */
export function HostUserSystemProvider({ children }: { children: ReactNode }) {
  const hostId = useHostId();
  const local = useUserSystem();
  const remoteHostId = shouldOverrideLocalUserSystem(hostId) ? hostId : null;

  const queryKey = useMemo(
    () => ['user-system', 'local-route', remoteHostId] as const,
    [remoteHostId]
  );
  const load = useCallback(
    () => configApi.getConfig(remoteHostId),
    [remoteHostId]
  );
  const save = useCallback(
    (config: Parameters<typeof configApi.saveConfig>[0], revision: string) =>
      configApi.saveConfig(config, revision, remoteHostId),
    [remoteHostId]
  );
  const { value: remote } = useUserSystemController({
    queryKey,
    load,
    save,
    enabled: remoteHostId !== null,
  });

  return (
    <UserSystemContext.Provider value={remoteHostId !== null ? remote : local}>
      {children}
    </UserSystemContext.Provider>
  );
}
