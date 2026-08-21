import { ReactNode, useEffect } from "react";
import { useAuth } from "@/shared/hooks/auth/useAuth";
import { useUserSystemController } from "@/shared/hooks/useUserSystemController";
import { useConfigPreferenceSync } from "@/shared/hooks/useConfigPreferenceSync";
import { DEFAULT_CONFIG } from "@/shared/lib/defaultConfig";
import {
  REMOTE_SHARED_USER_SYSTEM_QUERY_KEY,
  loadRemoteSharedUserSystemInfo,
  saveRemoteSharedConfig,
} from "@/shared/lib/remoteSharedConfig";
import {
  applyPrimaryColor,
  persistPrimaryColor,
  persistTheme,
} from "@/shared/lib/themeColors";
import { persistLanguage, updateLanguageFromConfig } from "@/i18n/config";
import { useTheme } from "@/shared/hooks/useTheme";

interface RemoteSharedConfigProviderProps {
  children: ReactNode;
}

/**
 * Applies the account-scoped "Remote" device config to the remote-web shell so
 * settings edited on one device take effect on every other. It is a passthrough
 * (does not provide UserSystemContext — host-owned behavior still comes from the
 * route host via RemoteUserSystemProvider); it only drives appearance and syncs
 * the device-local UI preference stores with the shared config.
 *
 * Appearance (theme mode, primary color, language) is applied only when it
 * differs from the default, so a brand-new account (all defaults) never clobbers
 * a device's own browser-local appearance — the shared value wins only once the
 * user has explicitly chosen one in the Remote settings.
 */
export function RemoteSharedConfigProvider({
  children,
}: RemoteSharedConfigProviderProps) {
  const { isSignedIn, isLoaded } = useAuth();
  const { setTheme } = useTheme();

  const { value } = useUserSystemController({
    queryKey: REMOTE_SHARED_USER_SYSTEM_QUERY_KEY,
    enabled: isLoaded && isSignedIn,
    load: loadRemoteSharedUserSystemInfo,
    save: saveRemoteSharedConfig,
  });

  const config = value.config;
  const theme = config?.theme;
  const primaryColor = config?.primary_color;
  const language = config?.language;

  useEffect(() => {
    if (theme != null && theme !== DEFAULT_CONFIG.theme) {
      setTheme(theme);
      persistTheme(theme);
    }
  }, [setTheme, theme]);

  useEffect(() => {
    if (primaryColor && primaryColor !== DEFAULT_CONFIG.primary_color) {
      applyPrimaryColor(primaryColor);
      persistPrimaryColor(primaryColor);
    }
  }, [primaryColor]);

  useEffect(() => {
    if (language && language !== DEFAULT_CONFIG.language) {
      updateLanguageFromConfig(language);
      persistLanguage(language);
    }
  }, [language]);

  // Sync device-local UI preferences (keyboard shortcuts, theme variant/presets,
  // diff view, quick-chat favorites) with the shared config so they persist and
  // surface on other devices after a reload.
  useConfigPreferenceSync(config, value.updateAndSaveConfig);

  return <>{children}</>;
}
