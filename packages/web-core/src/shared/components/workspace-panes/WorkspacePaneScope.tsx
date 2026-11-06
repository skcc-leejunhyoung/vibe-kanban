import { useCallback, useMemo, type ReactNode } from 'react';
import {
  AppNavigationProvider,
  useAppNavigation,
} from '@/shared/hooks/useAppNavigation';
import { AppDestinationOverrideProvider } from '@/shared/hooks/useCurrentAppDestination';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import {
  createPaneAppNavigation,
  type PaneNavigationController,
} from '@/shared/lib/routes/paneNavigation';
import type { WorkspacePaneDestination } from '@/shared/stores/useWorkspacePanesStore';
import { HostIdProvider, useHostId } from '@/shared/providers/HostIdProvider';
import { WorkspaceProvider } from '@/shared/providers/WorkspaceProvider';
import { ExecutionProcessesProvider } from '@/shared/providers/ExecutionProcessesProvider';
import { LogsPanelProvider } from '@/shared/providers/LogsPanelProvider';
import { ActionsProvider } from '@/shared/providers/ActionsProvider';
import { useMarkNotificationsReadOnView } from '@/shared/hooks/useMarkNotificationsReadOnView';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { UserSystemContext } from '@/shared/hooks/useUserSystem';
import { useUserSystemController } from '@/shared/hooks/useUserSystemController';
import { configApi } from '@/shared/lib/api';

interface WorkspacePaneScopeProps {
  paneId: string;
  destination: WorkspacePaneDestination;
  /** Rebinds pane-renderable navigation issued inside the pane to pane state. */
  onNavigate: (destination: WorkspacePaneDestination) => void;
  children: ReactNode;
}

function PaneUserSystemProvider({ children }: { children: ReactNode }) {
  const hostId = useHostId();
  const runtime = useAppRuntime();
  const { isLoaded, isSignedIn } = useAuth();
  // Share the shell's host cache, but never inherit its active-host settings.
  const queryKey = useMemo(() => {
    if (runtime === 'remote') {
      return ['user-system', 'remote-route', hostId ?? 'none'] as const;
    }
    return hostId === null
      ? (['user-system', 'local'] as const)
      : (['user-system', 'local-route', hostId] as const);
  }, [runtime, hostId]);
  const load = useCallback(() => configApi.getConfig(hostId), [hostId]);
  const save = useCallback(
    (config: Parameters<typeof configApi.saveConfig>[0], revision: string) =>
      configApi.saveConfig(config, revision, hostId),
    [hostId]
  );
  const { value } = useUserSystemController({
    queryKey,
    load,
    save,
    enabled: runtime === 'local' || (isLoaded && isSignedIn && hostId !== null),
    loading: runtime === 'remote' && !isLoaded ? true : undefined,
  });
  return (
    <UserSystemContext.Provider value={value}>
      {children}
    </UserSystemContext.Provider>
  );
}

function ExecutionProcessesFromContext({ children }: { children: ReactNode }) {
  const { selectedSessionId } = useWorkspaceContext();
  return (
    <ExecutionProcessesProvider sessionId={selectedSessionId}>
      {children}
    </ExecutionProcessesProvider>
  );
}

function MarkNotificationsReadOnView() {
  useMarkNotificationsReadOnView();
  return null;
}

/**
 * Provider stack for one split pane: the same providers the routed page gets,
 * but scoped by an explicit destination instead of the document URL, so
 * several views can coexist in one document.
 */
export function WorkspacePaneScope({
  paneId,
  destination,
  onNavigate,
  children,
}: WorkspacePaneScopeProps) {
  const base = useAppNavigation();

  const paneNavigation = useMemo(() => {
    const controller: PaneNavigationController = {
      getDestination: () => destination,
      setDestination: onNavigate,
    };
    return createPaneAppNavigation(base, controller);
  }, [base, destination, onNavigate]);

  return (
    <AppNavigationProvider value={paneNavigation}>
      <AppDestinationOverrideProvider value={destination}>
        <MarkNotificationsReadOnView />
        <HostIdProvider global={false}>
          <PaneUserSystemProvider>
            <WorkspaceProvider inheritStreams>
              <ExecutionProcessesFromContext>
                <LogsPanelProvider>
                  <ActionsProvider paneId={paneId}>{children}</ActionsProvider>
                </LogsPanelProvider>
              </ExecutionProcessesFromContext>
            </WorkspaceProvider>
          </PaneUserSystemProvider>
        </HostIdProvider>
      </AppDestinationOverrideProvider>
    </AppNavigationProvider>
  );
}
