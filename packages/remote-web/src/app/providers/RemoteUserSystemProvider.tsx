import { ReactNode, useCallback, useEffect, useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { configApi } from "@/shared/lib/api";
import { useAuth } from "@/shared/hooks/auth/useAuth";
import { useUserSystemController } from "@/shared/hooks/useUserSystemController";
import { UserSystemContext } from "@/shared/hooks/useUserSystem";
import {
  applyPrimaryColor,
  applyTheme,
  persistPrimaryColor,
  persistTheme,
} from "@/shared/lib/themeColors";
import { persistLanguage, updateLanguageFromConfig } from "@/i18n/config";

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

  // Apply + cache UI preferences whenever config is (re)loaded. Only act when a
  // value is present: routes without a hostId (e.g. /projects/$id) don't load
  // host config, so these are undefined there and must NOT reset to defaults —
  // the values cached at boot (Bootstrap) keep them on those routes.
  useEffect(() => {
    const primaryColor = contextValue.config?.primary_color;
    if (primaryColor) {
      applyPrimaryColor(primaryColor);
      persistPrimaryColor(primaryColor);
    }
  }, [contextValue.config?.primary_color]);

  useEffect(() => {
    const theme = contextValue.config?.theme;
    if (theme) {
      applyTheme(theme);
      persistTheme(theme);
    }
  }, [contextValue.config?.theme]);

  useEffect(() => {
    const language = contextValue.config?.language;
    if (language) {
      updateLanguageFromConfig(language);
      persistLanguage(language);
    }
  }, [contextValue.config?.language]);

  return (
    <UserSystemContext.Provider value={contextValue}>
      {children}
    </UserSystemContext.Provider>
  );
}
