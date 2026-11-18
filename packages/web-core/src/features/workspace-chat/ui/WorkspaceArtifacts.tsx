import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ArtifactSummary } from 'shared/types';
import { ownedArtifactsApi } from '@/shared/lib/api';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { DrawerArtifact } from './DrawerArtifact';

export function useWorkspaceArtifacts(workspaceId: string, sessionId?: string) {
  const hostId = useHostId();
  const { isLoaded, isSignedIn, userId } = useAuth();
  return useQuery({
    queryKey: ['workspace-artifacts', userId, hostId, workspaceId, sessionId],
    queryFn: ({ signal }) =>
      ownedArtifactsApi.list(workspaceId, sessionId!, hostId, signal),
    enabled: isLoaded && isSignedIn && !!sessionId,
    retry: false,
    gcTime: 0,
    refetchInterval: 15000,
  });
}

export function WorkspaceArtifacts({
  items,
  workspaceId,
  sessionId,
  archived,
  failed,
}: {
  items: ArtifactSummary[];
  workspaceId: string;
  sessionId: string;
  archived: boolean;
  failed: boolean;
}) {
  const hostId = useHostId();
  const { t } = useTranslation('common');
  if (failed)
    return (
      <p role="alert" className="px-double text-low">
        {t('artifacts.drawer.unavailable')}
      </p>
    );
  if (!items.length) return null;
  return (
    <section className="px-double py-base">
      {items.map((item) => (
        <DrawerArtifact
          key={`${item.id}:${item.version}`}
          id={item.id}
          workspaceId={workspaceId}
          sessionId={sessionId}
          hostId={hostId}
          archived={archived}
        />
      ))}
    </section>
  );
}
