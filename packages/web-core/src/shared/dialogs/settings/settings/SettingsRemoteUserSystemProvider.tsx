import { ReactNode } from 'react';
import { UserSystemContext } from '@/shared/hooks/useUserSystem';
import { useUserSystemController } from '@/shared/hooks/useUserSystemController';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import {
  REMOTE_SHARED_USER_SYSTEM_QUERY_KEY,
  loadRemoteSharedUserSystemInfo,
  saveRemoteSharedConfig,
} from '@/shared/lib/remoteSharedConfig';

/**
 * Backs the settings sections for the "Remote" device — the account-scoped,
 * cloud-stored Config shared across every remote-web session. Unlike the
 * machine provider, there is no host: config load/save go to the remote
 * server's `/v1/user-web-settings`.
 */
export function SettingsRemoteUserSystemProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { isSignedIn } = useAuth();

  const { value } = useUserSystemController({
    queryKey: REMOTE_SHARED_USER_SYSTEM_QUERY_KEY,
    enabled: isSignedIn,
    load: loadRemoteSharedUserSystemInfo,
    save: saveRemoteSharedConfig,
  });

  return (
    <UserSystemContext.Provider value={value}>
      {children}
    </UserSystemContext.Provider>
  );
}
