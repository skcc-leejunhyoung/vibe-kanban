import { createFileRoute } from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { RemoteWorkspacesPageShell } from "@remote/pages/RemoteWorkspacesPageShell";
import { WorkspacesListPage } from "@/pages/workspaces/WorkspacesListPage";

export const Route = createFileRoute("/workspaces")({
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: WorkspacesRouteComponent,
});

function WorkspacesRouteComponent() {
  return (
    <RemoteWorkspacesPageShell>
      <WorkspacesListPage />
    </RemoteWorkspacesPageShell>
  );
}
