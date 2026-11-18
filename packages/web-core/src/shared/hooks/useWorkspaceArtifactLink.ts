import { useEffect, useRef } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useSelfCloudHostId } from '@/shared/hooks/useSelfCloudHostId';
import {
  selectWorkspaceSession,
  useWorkspaceSessionSelectionStore,
  workspaceSessionSelectionKey,
  type SessionSelection,
} from '@/shared/hooks/useWorkspaceSessions';
import { ownedArtifactsApi, type ApiError } from '@/shared/lib/api';
import { foldSelfHostDestination } from '@/shared/lib/routes/appNavigation';
import { useHostId } from '@/shared/providers/HostIdProvider';

/** Resolve existing transfer links through their authenticated, current owner. */
export function useWorkspaceArtifactLink(workspaceId: string | undefined) {
  const { href } = useLocation();
  const navigation = useAppNavigation();
  const hostId = useHostId();
  const self = useSelfCloudHostId();
  const { isLoaded, isSignedIn, userId } = useAuth();
  const destination = foldSelfHostDestination(
    navigation.resolveFromPath(href),
    self.hostId
  );
  const matches =
    destination?.kind === 'workspace' &&
    destination.workspaceId === workspaceId &&
    (destination.hostId ?? null) === hostId;
  const artifactId = new URL(href, 'http://localhost').searchParams.get(
    'artifact'
  );
  const enabled =
    isLoaded && isSignedIn && !self.isPending && matches && !!artifactId;
  const selectionKey = workspaceSessionSelectionKey(workspaceId, hostId);
  const initialSelection = useRef<SessionSelection | undefined>(undefined);
  useEffect(() => {
    initialSelection.current =
      useWorkspaceSessionSelectionStore.getState().selections[selectionKey];
  }, [enabled, selectionKey, href, userId]);
  const transfer = useQuery({
    queryKey: [
      'workspace-artifact-link',
      userId,
      hostId,
      workspaceId,
      artifactId,
    ],
    queryFn: ({ signal }) =>
      ownedArtifactsApi.transferStatus(artifactId!, hostId, signal),
    enabled,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => {
      const error = query.state.error as ApiError | null;
      if (error)
        return !error.statusCode || error.statusCode >= 500 ? 10000 : false;
      return query.state.data?.status === 'pending' ? 2000 : false;
    },
  });
  useEffect(() => {
    const owner = transfer.data?.source;
    const selection =
      useWorkspaceSessionSelectionStore.getState().selections[selectionKey];
    // A deliberate session change while the lookup was in flight wins.
    const changed =
      selection &&
      !('auto' in selection && selection.auto) &&
      selection !== initialSelection.current;
    if (
      enabled &&
      !changed &&
      transfer.data?.status === 'ready' &&
      owner?.kind === 'workspace' &&
      owner.workspace_id === workspaceId
    ) {
      selectWorkspaceSession(workspaceId, hostId, owner.session_id);
    }
  }, [enabled, transfer.data, workspaceId, hostId, href, selectionKey]);
}
