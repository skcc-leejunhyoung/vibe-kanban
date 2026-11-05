import { ReactNode, useCallback, useEffect } from 'react';
import { configApi } from '@/shared/lib/api';
import { updateLanguageFromConfig } from '@/i18n/config';
import { setRemoteApiBase } from '@/shared/lib/remoteApi';
import { useUserSystemController } from '@/shared/hooks/useUserSystemController';
import { useConfigPreferenceSync } from '@/shared/hooks/useConfigPreferenceSync';
import { UserSystemContext } from '@/shared/hooks/useUserSystem';
import { tokenManager } from '@/shared/lib/auth/tokenManager';
import { useTranslation } from 'react-i18next';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';

interface UserSystemProviderProps {
  children: ReactNode;
}

export function UserSystemProvider({ children }: UserSystemProviderProps) {
  const { t } = useTranslation('common');
  const loadConfig = useCallback(() => configApi.getConfig(null), []);
  const saveConfig = useCallback(
    (config: Parameters<typeof configApi.saveConfig>[0], revision: string) =>
      configApi.saveConfig(config, revision, null),
    []
  );

  const { value, userSystemInfo } = useUserSystemController({
    queryKey: ['user-system', 'local'],
    load: loadConfig,
    save: saveConfig,
  });

  // Set runtime remote API base URL for self-hosting support.
  // Must run during render (not in useEffect) so it's set before children mount.
  if (userSystemInfo) {
    setRemoteApiBase(userSystemInfo.shared_api_base);
  }

  // Sync language with i18n when config changes
  useEffect(() => {
    if (value.config?.language) {
      updateLanguageFromConfig(value.config.language);
    }
  }, [value.config?.language]);

  useEffect(() => {
    tokenManager.syncRecoveryState();
  }, [value.loginStatus?.status, value.remoteAuthDegraded]);

  // Sync device-local UI preferences (keyboard shortcuts, theme variant/presets,
  // diff view) with config so they persist server-side + across devices.
  useConfigPreferenceSync(value.config, value.updateAndSaveConfig);

  // Shapes capture their URL at creation, so no consumer may mount earlier.
  if (!userSystemInfo) {
    return (
      <div
        className="new-design flex min-h-screen flex-col items-center justify-center gap-base bg-primary text-normal"
        role="status"
      >
        <p>
          {value.configError ? t('bootstrap.loadFailed') : t('states.loading')}
        </p>
        {value.configError && (
          <PrimaryButton
            disabled={value.configRefreshing}
            onClick={() => void value.reloadSystem()}
          >
            {t('buttons.retry')}
          </PrimaryButton>
        )}
      </div>
    );
  }

  return (
    <UserSystemContext.Provider value={value}>
      {children}
    </UserSystemContext.Provider>
  );
}
