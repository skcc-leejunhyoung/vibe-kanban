import { ReactNode, useCallback, useEffect, useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { configApi } from "@/shared/lib/api";
import { useAuth } from "@/shared/hooks/auth/useAuth";
import { useUserSystemController } from "@/shared/hooks/useUserSystemController";
import { UserSystemContext } from "@/shared/hooks/useUserSystem";
import {
  applyPrimaryColor,
  persistPrimaryColor,
} from "@/shared/lib/themeColors";

interface RemoteUserSystemProviderProps {
  children: ReactNode;
}

export function RemoteUserSystemProvider({
  children,
}: RemoteUserSystemProviderProps) {
  const { isSignedIn, isLoaded } = useAuth();
  const { hostId } = useParams({ strict: false });
  const loadConfig = useCallback(() => configApi.getConfig(), []);
  const saveConfig = useCallback(
    (config: Parameters<typeof configApi.saveConfig>[0]) =>
      configApi.saveConfig(config),
    [],
  );
  const userSystemQueryKey = useMemo(
    () => ["user-system", "remote-route", hostId] as const,
    [hostId],
  );
  const { value, isLoading } = useUserSystemController({
    queryKey: userSystemQueryKey,
    enabled: isLoaded && isSignedIn && !!hostId,
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

  // Apply + cache the saved primary color whenever config is (re)loaded. Only
  // act when a value is present: routes without a hostId (e.g. /projects/$id)
  // don't load host config, so config?.primary_color is undefined there and we
  // must NOT reset to the default — the value cached at boot (Bootstrap) keeps
  // the color on those routes.
  useEffect(() => {
    const primaryColor = contextValue.config?.primary_color;
    if (primaryColor) {
      applyPrimaryColor(primaryColor);
      persistPrimaryColor(primaryColor);
    }
  }, [contextValue.config?.primary_color]);

  return (
    <UserSystemContext.Provider value={contextValue}>
      {children}
    </UserSystemContext.Provider>
  );
}
