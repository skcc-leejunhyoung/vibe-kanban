import { type ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Provider as NiceModalProvider } from '@ebay/nice-modal-react';
import { HostIdProvider } from '@/shared/providers/HostIdProvider';
import { WorkspaceProvider } from '@/shared/providers/WorkspaceProvider';
import { ExecutionProcessesProvider } from '@/shared/providers/ExecutionProcessesProvider';
import { ActionsProvider } from '@/shared/providers/ActionsProvider';
import { TerminalProvider } from '@/shared/providers/TerminalProvider';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { VSCodeWorkspacePage } from '@/pages/workspaces/VSCodeWorkspacePage';
import { HostUserSystemProvider } from '@web/app/providers/HostUserSystemProvider';

function ExecutionProcessesProviderWrapper({
  children,
}: {
  children: ReactNode;
}) {
  const { selectedSessionId } = useWorkspaceContext();

  return (
    <ExecutionProcessesProvider sessionId={selectedSessionId}>
      {children}
    </ExecutionProcessesProvider>
  );
}

function VSCodeWorkspaceRouteComponent() {
  return (
    <HostIdProvider>
      <HostUserSystemProvider>
        <WorkspaceProvider>
          <ExecutionProcessesProviderWrapper>
            <ActionsProvider>
              <NiceModalProvider>
                <TerminalProvider>
                  <VSCodeWorkspacePage />
                </TerminalProvider>
              </NiceModalProvider>
            </ActionsProvider>
          </ExecutionProcessesProviderWrapper>
        </WorkspaceProvider>
      </HostUserSystemProvider>
    </HostIdProvider>
  );
}

export const Route = createFileRoute('/workspaces/$workspaceId/vscode')({
  component: VSCodeWorkspaceRouteComponent,
});
