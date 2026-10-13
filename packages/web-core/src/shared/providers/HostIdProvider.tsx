import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { useSelfCloudHostId } from '@/shared/hooks/useSelfCloudHostId';
import { getDestinationHostId } from '@/shared/lib/routes/appNavigation';

// Module-level getter so the API transport can read the hostId outside React
let _hostId: string | null = null;
export function getCurrentHostId(): string | null {
  return _hostId;
}

export const HostIdContext = createContext<string | null>(null);

export function useHostId(): string | null {
  return useContext(HostIdContext);
}

export function HostIdProvider({
  children,
  global = true,
}: {
  children: ReactNode;
  /**
   * When false, this instance only scopes its React subtree and leaves the
   * module-level hostId (read by the API transport fallback) to the
   * document-level provider. Split panes pass false so several panes can
   * coexist without clobbering the document's host scope.
   */
  global?: boolean;
}) {
  const destination = useCurrentAppDestination();
  const routeHostId = useMemo(
    () => getDestinationHostId(destination),
    [destination]
  );
  const { isPending: isSelfHostPending } = useSelfCloudHostId();
  // The route parser folds this machine's own cloud host id to the local host
  // (`null`). Until that id is known a host route may still be self, so hold
  // rendering rather than relay-proxy to ourselves.
  const resolvedHostId =
    routeHostId !== null && isSelfHostPending ? undefined : routeHostId;
  const hostId = resolvedHostId ?? null;

  useLayoutEffect(() => {
    if (!global) return;
    _hostId = hostId;
    return () => {
      _hostId = null;
    };
  }, [hostId, global]);

  if (resolvedHostId === undefined) return null;

  return (
    <HostIdContext.Provider value={hostId}>{children}</HostIdContext.Provider>
  );
}
