import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { useSelfCloudHostId } from '@/shared/hooks/useSelfCloudHostId';
import {
  getDestinationHostId,
  resolveLocalHostId,
} from '@/shared/lib/routes/appNavigation';

// Module-level getter so the API transport can read the hostId outside React
let _hostId: string | null = null;
export function getCurrentHostId(): string | null {
  return _hostId;
}

const HostIdContext = createContext<string | null>(null);

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
  const { hostId: selfHostId, isPending: isSelfHostPending } =
    useSelfCloudHostId();
  // A route that targets this machine's own cloud host id must be served
  // directly (`/api`, host `null`), never relay-proxied to ourselves: self is
  // never in the pairing store, so proxying to it 400s with "No paired relay
  // credentials". Collapsing here — the single choke point every host-scoped
  // request reads via useHostId()/getCurrentHostId() — fixes it regardless of
  // where the self-host link came from (notification deep-link, bookmark, …).
  const resolvedHostId = useMemo(
    () => resolveLocalHostId(routeHostId, selfHostId, isSelfHostPending),
    [routeHostId, selfHostId, isSelfHostPending]
  );
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
