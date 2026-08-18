import { useMemo, type ReactNode } from 'react';
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
import { HostIdProvider } from '@/shared/providers/HostIdProvider';
import { WorkspaceProvider } from '@/shared/providers/WorkspaceProvider';
import { ExecutionProcessesProvider } from '@/shared/providers/ExecutionProcessesProvider';
import { LogsPanelProvider } from '@/shared/providers/LogsPanelProvider';
import { ActionsProvider } from '@/shared/providers/ActionsProvider';
import { useMarkNotificationsReadOnView } from '@/shared/hooks/useMarkNotificationsReadOnView';

interface WorkspacePaneScopeProps {
  destination: WorkspacePaneDestination;
  /** Rebinds pane-renderable navigation issued inside the pane to pane state. */
  onNavigate: (destination: WorkspacePaneDestination) => void;
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
