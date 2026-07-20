import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BaseAgentCapability,
  Config,
  Environment,
  ExecutorProfile,
  UserSystemInfo,
} from 'shared/types';
import type { UserSystemContextType } from './useUserSystem';

interface UseUserSystemControllerOptions {
  queryKey: readonly unknown[];
  enabled?: boolean;
  load: () => Promise<UserSystemInfo>;
  save: (
    config: Config,
    revision: string
  ) => Promise<{ config: Config; revision: string }>;
  loading?: boolean;
}

export function useUserSystemController({
  queryKey,
  enabled = true,
  load,
  save,
  loading: loadingOverride,
}: UseUserSystemControllerOptions): {
  value: UserSystemContextType;
  userSystemInfo: UserSystemInfo | undefined;
  isLoading: boolean;
} {
  const queryClient = useQueryClient();

  const { data: userSystemInfo, isLoading } = useQuery({
    queryKey,
    queryFn: load,
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  const config = userSystemInfo?.config || null;
  const configRevision = userSystemInfo?.config_revision || null;
  const profilesRevision = userSystemInfo?.profiles_revision || null;
  const appVersion = userSystemInfo?.version || null;
  const previewProxyPort = userSystemInfo?.preview_proxy_port ?? null;
  const environment = userSystemInfo?.environment || null;
  const machineId = userSystemInfo?.machine_id || null;
  const loginStatus = userSystemInfo?.login_status || null;
  const remoteAuthDegraded = userSystemInfo?.remote_auth_degraded || null;
  const profiles =
    (userSystemInfo?.executors as Record<string, ExecutorProfile> | null) ||
    null;
  const capabilities =
    (userSystemInfo?.capabilities as Record<
      string,
      BaseAgentCapability[]
    > | null) || null;
  const loading = loadingOverride ?? isLoading;

  const updateConfig = useCallback(
    (updates: Partial<Config>) => {
      queryClient.setQueryData<UserSystemInfo>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          config: { ...old.config, ...updates },
        };
      });
    },
    [queryClient, queryKey]
  );

  const saveConfig = useCallback(async (): Promise<boolean> => {
    if (!config || !configRevision) return false;
    try {
      const saved = await save(config, configRevision);
      queryClient.setQueryData<UserSystemInfo>(queryKey, (old) =>
        old
          ? {
              ...old,
              config: saved.config,
              config_revision: saved.revision,
            }
          : old
      );
      return true;
    } catch (err) {
      console.error('Error saving config:', err);
      return false;
    }
  }, [config, configRevision, queryClient, queryKey, save]);

  const updateAndSaveConfig = useCallback(
    async (updates: Partial<Config>): Promise<boolean> => {
      if (!config || !configRevision) return false;

      const newConfig = { ...config, ...updates };
      updateConfig(updates);

      try {
        const saved = await save(newConfig, configRevision);
        queryClient.setQueryData<UserSystemInfo>(queryKey, (old) => {
          if (!old) return old;
          return {
            ...old,
            config: saved.config,
            config_revision: saved.revision,
          };
        });
        return true;
      } catch (err) {
        console.error('Error saving config:', err);
        queryClient.invalidateQueries({ queryKey });
        return false;
      }
    },
    [config, configRevision, queryClient, queryKey, save, updateConfig]
  );

  const reloadSystem = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const setEnvironment = useCallback(
    (env: Environment | null) => {
      queryClient.setQueryData<UserSystemInfo>(queryKey, (old) => {
        if (!old || !env) return old;
        return { ...old, environment: env };
      });
    },
    [queryClient, queryKey]
  );

  const setProfiles = useCallback(
    (
      newProfiles: Record<string, ExecutorProfile> | null,
      revision?: string
    ) => {
      queryClient.setQueryData<UserSystemInfo>(queryKey, (old) => {
        if (!old || !newProfiles) return old;
        return {
          ...old,
          executors: newProfiles as unknown as UserSystemInfo['executors'],
          profiles_revision: revision ?? old.profiles_revision,
        };
      });
    },
    [queryClient, queryKey]
  );

  const setCapabilities = useCallback(
    (newCapabilities: Record<string, BaseAgentCapability[]> | null) => {
      queryClient.setQueryData<UserSystemInfo>(queryKey, (old) => {
        if (!old || !newCapabilities) return old;
        return { ...old, capabilities: newCapabilities };
      });
    },
    [queryClient, queryKey]
  );

  const value = useMemo<UserSystemContextType>(
    () => ({
      system: {
        appVersion,
        previewProxyPort,
        config,
        environment,
        profiles,
        profilesRevision,
        capabilities,
        machineId,
        loginStatus,
        remoteAuthDegraded,
      },
      appVersion,
      previewProxyPort,
      config,
      environment,
      profiles,
      profilesRevision,
      capabilities,
      machineId,
      loginStatus,
      remoteAuthDegraded,
      updateConfig,
      saveConfig,
      updateAndSaveConfig,
      setEnvironment,
      setProfiles,
      setCapabilities,
      reloadSystem,
      loading,
    }),
    [
      machineId,
      appVersion,
      capabilities,
      config,
      environment,
      loading,
      previewProxyPort,
      loginStatus,
      remoteAuthDegraded,
      profiles,
      profilesRevision,
      reloadSystem,
      saveConfig,
      setCapabilities,
      setEnvironment,
      setProfiles,
      updateAndSaveConfig,
      updateConfig,
    ]
  );

  return {
    value,
    userSystemInfo,
    isLoading,
  };
}
