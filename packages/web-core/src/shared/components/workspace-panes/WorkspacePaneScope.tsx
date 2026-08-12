import { useMemo, type ReactNode } from 'react';
import {
  AppNavigationProvider,
  useAppNavigation,
} from '@/shared/hooks/useAppNavigation';
import { AppDestinationOverrideProvider } from '@/shared/hooks/useCurrentAppDestination';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import type { AppDestination } from '@/shared/lib/routes/appNavigation';
import {
  createPaneAppNavigation,
  type PaneNavigationController,
} from '@/shared/lib/routes/paneNavigation';
import { HostIdProvider } from '@/shared/providers/HostIdProvider';
import { WorkspaceProvider } from '@/shared/providers/WorkspaceProvider';
import { ExecutionProcessesProvider } from '@/shared/providers/ExecutionProcessesProvider';
import { LogsPanelProvider } from '@/shared/providers/LogsPanelProvider';
import { ActionsProvider } from '@/shared/providers/ActionsProvider';

interface WorkspacePaneScopeProps {
  workspaceId: string;
  hostId: string | null;
  /** Rebinds workspace navigation issued inside the pane to the pane state. */
  onNavigateWorkspace: (workspaceId: string, hostId: string | null) => void;
  children: ReactNode;
}

function ExecutionProcessesFromContext({ children }: { children: ReactNode }) {
  const { selectedSessionId } = useWorkspaceContext();
  return (
    <ExecutionProcessesProvider sessionId={selectedSessionId}>
      {children}
    </ExecutionProcessesProvider>
  );
}

/**
 * Provider stack for one split pane: the same providers the routed workspace
 * page gets, but scoped by an explicit destination instead of the document
 * URL, so several workspace views can coexist in one document.
 */
export function WorkspacePaneScope({
  workspaceId,
  hostId,
  onNavigateWorkspace,
  children,
}: WorkspacePaneScopeProps) {
  const base = useAppNavigation();

  const destination = useMemo<AppDestination>(
    () => ({ kind: 'workspace', workspaceId, hostId }),
    [workspaceId, hostId]
  );

  const paneNavigation = useMemo(() => {
    const controller: PaneNavigationController = {
      getDestination: () => destination,
      setDestination: (next) => {
        if (next.kind !== 'workspace') return;
        onNavigateWorkspace(next.workspaceId, next.hostId ?? null);
      },
    };
    return createPaneAppNavigation(base, controller);
  }, [base, destination, onNavigateWorkspace]);

  return (
    <AppNavigationProvider value={paneNavigation}>
      <AppDestinationOverrideProvider value={destination}>
        <HostIdProvider global={false}>
          <WorkspaceProvider inheritStreams>
            <ExecutionProcessesFromContext>
              <LogsPanelProvider>
                <ActionsProvider>{children}</ActionsProvider>
              </LogsPanelProvider>
            </ExecutionProcessesFromContext>
          </WorkspaceProvider>
        </HostIdProvider>
      </AppDestinationOverrideProvider>
    </AppNavigationProvider>
  );
}
