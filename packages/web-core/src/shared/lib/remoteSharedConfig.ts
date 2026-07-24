import type { Config, UserSystemInfo } from 'shared/types';
import {
  getUserWebSettings,
  saveUserWebSettings,
} from '@/shared/lib/remoteApi';
import { mergeRemoteConfig } from '@/shared/lib/defaultConfig';

/**
 * Shared React Query key for the account-scoped "Remote" device config. Both
 * the settings dialog (editing) and the remote-web shell (applying) read/write
 * this one cache entry so edits stay consistent without a refetch.
 */
export const REMOTE_SHARED_USER_SYSTEM_QUERY_KEY = [
  'user-system',
  'remote-shared',
] as const;

/**
 * Wrap a resolved Config in a `UserSystemInfo`. The Remote device has no backing
 * machine, so machine-scoped fields are empty; the settings sections and shell
 * effects that consume this read only `config`.
 */
export function buildRemoteSharedUserSystemInfo(
  config: Config,
  configRevision: string
): UserSystemInfo {
  return {
    config,
    config_revision: configRevision,
    version: '',
    profiles_revision: '',
    machine_id: '',
    capabilities: {},
    executors: {},
    shared_api_base: null,
    preview_proxy_port: null,
    login_status: null,
    remote_auth_degraded: null,
    environment: null,
  } as unknown as UserSystemInfo;
}

export async function loadRemoteSharedUserSystemInfo(): Promise<UserSystemInfo> {
  const stored = await getUserWebSettings();
  return buildRemoteSharedUserSystemInfo(
    mergeRemoteConfig(stored.settings),
    stored.config_revision
  );
}

export async function saveRemoteSharedConfig(
  config: Config,
  revision: string
): Promise<{ config: Config; revision: string }> {
  const saved = await saveUserWebSettings(config, revision);
  return {
    config: mergeRemoteConfig(saved.settings),
    revision: saved.config_revision,
  };
}
