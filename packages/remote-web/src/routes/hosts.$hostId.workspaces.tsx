import {
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { WorkspacesLanding } from "@/pages/workspaces/WorkspacesLanding";
import { WorkspacesSidebarContainer } from "@/pages/workspaces/WorkspacesSidebarContainer";
import { RemoteWorkspacesPageShell } from "@remote/pages/RemoteWorkspacesPageShell";
import { useIsMobile } from "@/shared/hooks/useIsMobile";
import { useWorkspaceContext } from "@/shared/hooks/useWorkspaceContext";

export const Route = createFileRoute("/hosts/$hostId/workspaces")({
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: WorkspacesRouteComponent,
});

function WorkspacesRouteComponent() {
  const isMobile = useIsMobile();
  return (
    <RemoteWorkspacesPageShell>
      {isMobile ? <RemoteMobileWorkspacesSidebar /> : <WorkspacesLanding />}
    </RemoteWorkspacesPageShell>
  );
}

/**
 * Remote mobile workspaces list. Reuses the shared web-core sidebar (same as
 * desktop and local mobile) so search, sort, filter, grouping (issue view), and
 * the accordion/flat layouts are all available and behave identically. Only the
 * navigation differs: selecting a workspace — or "new" — routes to the host's
 * workspace pages instead of switching an in-page mobile tab.
 */
function RemoteMobileWorkspacesSidebar() {
  const navigate = useNavigate();
  const { hostId } = useParams({ from: "/hosts/$hostId/workspaces" });
  const { selectWorkspace } = useWorkspaceContext();

  return (
    <WorkspacesSidebarContainer
      onSelectWorkspaceOverride={(id) => {
        selectWorkspace(id);
        navigate({
          to: "/hosts/$hostId/workspaces/$workspaceId",
          params: { hostId, workspaceId: id },
        });
      }}
      onAddWorkspaceOverride={() =>
        navigate({
          to: "/hosts/$hostId/workspaces/create",
          params: { hostId },
        })
      }
    />
  );
}
