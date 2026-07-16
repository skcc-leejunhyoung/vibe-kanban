import { type ReactNode, useEffect, useMemo } from "react";
import {
  createRootRoute,
  Outlet,
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { Provider as NiceModalProvider } from "@ebay/nice-modal-react";
import { RemoteActionsProvider } from "@remote/app/providers/RemoteActionsProvider";
import { RemoteUserSystemProvider } from "@remote/app/providers/RemoteUserSystemProvider";
import { RemoteAppShell } from "@remote/app/layout/RemoteAppShell";
import { UserProvider } from "@/shared/providers/remote/UserProvider";
import { WorkspaceProvider } from "@/shared/providers/WorkspaceProvider";
import { ExecutionProcessesProvider } from "@/shared/providers/ExecutionProcessesProvider";
import { TerminalProvider } from "@/shared/providers/TerminalProvider";
import { LogsPanelProvider } from "@/shared/providers/LogsPanelProvider";
import { ActionsProvider } from "@/shared/providers/ActionsProvider";
import { HostIdProvider } from "@/shared/providers/HostIdProvider";
import { useKanbanIssueComposerScratch } from "@/shared/hooks/useKanbanIssueComposerScratch";
import { useServiceWorkerNavigation } from "@/shared/hooks/useServiceWorkerNavigation";
import { useUiPreferencesScratch } from "@/shared/hooks/useUiPreferencesScratch";
import { useApplyThemeVariant } from "@/shared/lib/themeVariant";
import { useWorkspaceContext } from "@/shared/hooks/useWorkspaceContext";
import { AppNavigationProvider } from "@/shared/hooks/useAppNavigation";
import {
  SequenceTrackerProvider,
  SequenceIndicator,
  useWorkspaceShortcuts,
  useIssueShortcuts,
  useKeyShowHelp,
  Scope,
} from "@/shared/keyboard";
import { KeyboardShortcutsDialog } from "@/shared/dialogs/shared/KeyboardShortcutsDialog";
import {
  createRemoteHostAppNavigation,
  remoteAppNavigation,
  resolveRemoteDestinationFromPath,
} from "@remote/app/navigation/AppNavigation";
import {
  isProjectDestination,
  isWorkspacesDestination,
} from "@/shared/lib/routes/appNavigation";
import NotFoundPage from "../pages/NotFoundPage";
import { useWorkspaceHostSelectionStore } from "@/shared/stores/useWorkspaceHostSelectionStore";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

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

/**
 * Global keyboard shortcut that doesn't require workspace/actions context.
 * Renders inside HotkeysProvider (from App.tsx) but outside WorkspaceProvider.
 */
function GlobalKeyboardShortcuts() {
  useKeyShowHelp(
    () => {
      KeyboardShortcutsDialog.show();
    },
    { scope: Scope.GLOBAL },
  );
  return null;
}

/**
 * Workspace & issue keyboard shortcuts that require ActionsProvider + WorkspaceProvider.
 * Must be rendered inside WorkspaceRouteProviders.
 */
function WorkspaceKeyboardShortcuts() {
  useWorkspaceShortcuts();
  useIssueShortcuts();
  return null;
}

function WorkspaceRouteProviders({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <ExecutionProcessesProviderWrapper>
        <TerminalProvider>
          <LogsPanelProvider>
            <ActionsProvider>
              <WorkspaceKeyboardShortcuts />
              {children}
            </ActionsProvider>
          </LogsPanelProvider>
        </TerminalProvider>
      </ExecutionProcessesProviderWrapper>
    </WorkspaceProvider>
  );
}

function RootLayout() {
  useUiPreferencesScratch();
  useKanbanIssueComposerScratch();
  useServiceWorkerNavigation();
  // Inject the selected theme variant ("skin") CSS. The selection + presets
  // come from config (synced via useConfigPreferenceSync), matching local web.
  useApplyThemeVariant();
  const location = useLocation();
  const { hostId } = useParams({ strict: false });
  const routeHostId = hostId ?? null;
  const selectWorkspaceHost = useWorkspaceHostSelectionStore(
    (state) => state.selectHost,
  );

  // Project and workspace detail routes both carry the concrete owner host for
  // API routing. Keep that route scope in the shared unified-page selector;
  // hostless routes deliberately retain the last selection.
  useEffect(() => {
    if (routeHostId) {
      selectWorkspaceHost(routeHostId);
    }
  }, [routeHostId, selectWorkspaceHost]);
  const appNavigation = useMemo(
    () =>
      routeHostId
        ? createRemoteHostAppNavigation(routeHostId)
        : remoteAppNavigation,
    [routeHostId],
  );
  const isStandaloneRoute =
    location.pathname.startsWith("/account") ||
    location.pathname.startsWith("/login") ||
    location.pathname.startsWith("/invitations");
  const destination = resolveRemoteDestinationFromPath(location.pathname);
  const isWorkspaceProviderRoute =
    isProjectDestination(destination) || isWorkspacesDestination(destination);

  const pageContent = isStandaloneRoute ? (
    <Outlet />
  ) : (
    <SequenceTrackerProvider>
      <SequenceIndicator />
      <GlobalKeyboardShortcuts />
      <RemoteAppShell>
        <Outlet />
      </RemoteAppShell>
    </SequenceTrackerProvider>
  );

  const content = isWorkspaceProviderRoute ? (
    <WorkspaceRouteProviders>
      <NiceModalProvider>{pageContent}</NiceModalProvider>
    </WorkspaceRouteProviders>
  ) : (
    <NiceModalProvider>{pageContent}</NiceModalProvider>
  );

  return (
    <AppNavigationProvider value={appNavigation}>
      <UserProvider>
        <RemoteActionsProvider>
          <RemoteUserSystemProvider>
            <HostIdProvider>{content}</HostIdProvider>
          </RemoteUserSystemProvider>
        </RemoteActionsProvider>
      </UserProvider>
    </AppNavigationProvider>
  );
}
