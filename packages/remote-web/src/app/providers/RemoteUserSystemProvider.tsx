import { ReactNode, useCallback, useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { configApi } from "@/shared/lib/api";
import { useAuth } from "@/shared/hooks/auth/useAuth";
import { useUserSystemController } from "@/shared/hooks/useUserSystemController";
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
  const loadConfig = useCallback(() => configApi.getConfig(hostId), [hostId]);
  const saveConfig = useCallback(
    (config: Parameters<typeof configApi.saveConfig>[0], revision: string) =>
      configApi.saveConfig(config, revision, hostId),
    [hostId],
  );
  const userSystemQueryKey = useMemo(
    () => ["user-system", "remote-route", routeHostId ?? "none"] as const,
    [routeHostId],
  );
  const { value, isLoading } = useUserSystemController({
    queryKey: userSystemQueryKey,
    enabled: isLoaded && isSignedIn && hasRemoteRouteHost(routeHostId),
    load: loadConfig,
    save: saveConfig,
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
