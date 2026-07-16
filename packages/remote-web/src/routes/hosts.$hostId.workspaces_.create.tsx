import { createFileRoute } from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { HostGatedWorkspaces } from "@remote/pages/RemoteWorkspacesPageShell";

export const Route = createFileRoute("/hosts/$hostId/workspaces_/create")({
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: WorkspacesCreateRouteComponent,
});

function WorkspacesCreateRouteComponent() {
  const { hostId } = Route.useParams();
  return <HostGatedWorkspaces hostId={hostId} />;
}
