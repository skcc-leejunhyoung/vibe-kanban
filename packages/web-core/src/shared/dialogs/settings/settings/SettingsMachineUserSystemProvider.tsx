import { ReactNode } from 'react';
import { UserSystemContext } from '@/shared/hooks/useUserSystem';
import { useHostUserSystem } from '@/shared/hooks/useHostUserSystem';
import { HostIdContext } from '@/shared/providers/HostIdProvider';
import { useSettingsMachineClient } from './SettingsHostContext';

/**
 * Scopes the host settings sections to the machine picked in the dialog: its
 * config cache entry is the one that host's panes and chat read, and host
 * lookups inside the sections resolve to it rather than to the document route.
 */
export function SettingsMachineUserSystemProvider({
  children,
}: {
  children: ReactNode;
}) {
  const machineClient = useSettingsMachineClient();
  const hostId = machineClient?.target.apiHostId ?? null;
  const { value } = useHostUserSystem(hostId, {
    enabled: machineClient != null,
  });

  return (
    <HostIdContext.Provider value={hostId}>
      <UserSystemContext.Provider value={value}>
        {children}
      </UserSystemContext.Provider>
    </HostIdContext.Provider>
  );
}
