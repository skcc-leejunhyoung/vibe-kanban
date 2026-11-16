import type { ReactNode } from 'react';
import { HostIdContext } from '@/shared/providers/HostIdProvider';
import { UserSystemContext } from '@/shared/hooks/useUserSystem';
import { useHostUserSystem } from '@/shared/hooks/useHostUserSystem';

/**
 * Scopes a subtree to one explicit host: `useHostId()` and `useUserSystem()`
 * inside both answer for that host. For surfaces with their own host picker
 * (dialogs), whose target is neither the document's nor the active pane's.
 */
export function HostUserSystemScope({
  hostId,
  enabled,
  children,
}: {
  hostId: string | null;
  /** False keeps the scope but sends nothing to the host (e.g. offline). */
  enabled?: boolean;
  children: ReactNode;
}) {
  const { value } = useHostUserSystem(hostId, { enabled });
  return (
    <HostIdContext.Provider value={hostId}>
      <UserSystemContext.Provider value={value}>
        {children}
      </UserSystemContext.Provider>
    </HostIdContext.Provider>
  );
}
