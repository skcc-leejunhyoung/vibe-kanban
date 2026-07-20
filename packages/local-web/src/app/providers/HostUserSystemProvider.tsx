import { type ReactNode, useCallback, useMemo } from 'react';
import { configApi } from '@/shared/lib/api';
import { useUserSystemController } from '@/shared/hooks/useUserSystemController';
import { UserSystemContext } from '@/shared/hooks/useUserSystem';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { shouldOverrideLocalUserSystem } from '@/shared/lib/hostRequestScope';

function RemoteHostUserSystemProvider({
  hostId,
  children,
}: {
  hostId: string;
  children: ReactNode;
}) {
  const queryKey = useMemo(
    () => ['user-system', 'local-route', hostId] as const,
    [hostId]
  );
  const load = useCallback(() => configApi.getConfig(hostId), [hostId]);
  const save = useCallback(
    (config: Parameters<typeof configApi.saveConfig>[0], revision: string) =>
      configApi.saveConfig(config, revision, hostId),
    [hostId]
  );
  const { value } = useUserSystemController({ queryKey, load, save });

  return (
    <UserSystemContext.Provider value={value}>
      {children}
    </UserSystemContext.Provider>
  );
}

/**
 * Local routes normally inherit the app-wide local machine config. A route
 * targeting a paired host gets its own immutable user-system scope instead.
 * Self-host routes collapse to null in HostIdProvider and keep the local value.
 */
export function HostUserSystemProvider({ children }: { children: ReactNode }) {
  const hostId = useHostId();
  if (!shouldOverrideLocalUserSystem(hostId)) return children;

  return (
    <RemoteHostUserSystemProvider hostId={hostId}>
      {children}
    </RemoteHostUserSystemProvider>
  );
}
