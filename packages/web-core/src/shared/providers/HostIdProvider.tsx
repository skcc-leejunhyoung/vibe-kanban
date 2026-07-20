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
  collapseSelfHostId,
  getDestinationHostId,
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

export function HostIdProvider({ children }: { children: ReactNode }) {
  const destination = useCurrentAppDestination();
  const routeHostId = useMemo(
    () => getDestinationHostId(destination),
    [destination]
  );
  const selfHostId = useSelfCloudHostId();
  // A route that targets this machine's own cloud host id must be served
  // directly (`/api`, host `null`), never relay-proxied to ourselves: self is
  // never in the pairing store, so proxying to it 400s with "No paired relay
  // credentials". Collapsing here — the single choke point every host-scoped
  // request reads via useHostId()/getCurrentHostId() — fixes it regardless of
  // where the self-host link came from (notification deep-link, bookmark, …).
  const hostId = useMemo(
    () => collapseSelfHostId(routeHostId, selfHostId),
    [routeHostId, selfHostId]
  );

  useLayoutEffect(() => {
    _hostId = hostId;
    return () => {
      _hostId = null;
    };
  }, [hostId]);

  return (
    <HostIdContext.Provider value={hostId}>{children}</HostIdContext.Provider>
  );
}
