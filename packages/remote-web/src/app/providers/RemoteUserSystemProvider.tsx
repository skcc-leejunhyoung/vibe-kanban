import { ReactNode, useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { useAuth } from "@/shared/hooks/auth/useAuth";
import { useHostUserSystem } from "@/shared/hooks/useHostUserSystem";
import { UserSystemContext } from "@/shared/hooks/useUserSystem";
import { useHostId } from "@/shared/providers/HostIdProvider";

interface RemoteUserSystemProviderProps {
  children: ReactNode;
}

export function hasRemoteRouteHost(hostId: string | undefined): boolean {
  return typeof hostId === "string" && hostId.length > 0;
}

export function RemoteUserSystemProvider({
  children,
}: RemoteUserSystemProviderProps) {
  const { isSignedIn, isLoaded } = useAuth();
  const { hostId: routeHostId } = useParams({ strict: false });
  const hostId = useHostId();
  // The cache entry, the load and the save all belong to the route host.
  const { value, isLoading } = useHostUserSystem(hostId, {
    enabled: hasRemoteRouteHost(routeHostId),
  });

  const contextValue = useMemo(
    () => ({
      ...value,
      loading: !isLoaded || (isSignedIn && isLoading),
    }),
    [isLoaded, isLoading, isSignedIn, value],
  );

  // Host config is still exposed for host-owned behavior (executors, editor,
  // repositories, etc.), but it must not drive the remote shell's appearance.
  // The remote app is one unified browser surface: Bootstrap restores its
  // browser-local theme before first paint, and navigating to a host only
  // changes the data/API scope. Applying primary color, theme, language, or UI
  // presets here made every host route look like a separate application.

  return (
    <UserSystemContext.Provider value={contextValue}>
      {children}
    </UserSystemContext.Provider>
  );
}
