import { createFileRoute } from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { RemoteWorkspacesPageShell } from "@remote/pages/RemoteWorkspacesPageShell";
import { WorkspacesSidebarContainer } from "@/pages/workspaces/WorkspacesSidebarContainer";
import { useIsMobile } from "@/shared/hooks/useIsMobile";

export const Route = createFileRoute("/workspaces")({
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: WorkspacesRouteComponent,
});

function WorkspacesRouteComponent() {
  const isMobile = useIsMobile();

  return (
    <RemoteWorkspacesPageShell>
      {isMobile ? (
        <WorkspacesSidebarContainer />
      ) : (
        <div className="flex h-full flex-1 items-center justify-center bg-primary px-double text-center text-sm text-low">
          Select a workspace from the list or create a new one.
        </div>
      )}
    </RemoteWorkspacesPageShell>
  );
}
