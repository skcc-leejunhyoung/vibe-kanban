import { useEffect } from "react";
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
import { QuickChatDialog } from "@/shared/dialogs/QuickChatDialog";

type WorkspacesSearch = { quickChat?: boolean };

export const Route = createFileRoute("/hosts/$hostId/workspaces")({
  validateSearch: (search: Record<string, unknown>): WorkspacesSearch => ({
    quickChat: search.quickChat === true ? true : undefined,
  }),
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: WorkspacesRouteComponent,
});

function WorkspacesRouteComponent() {
  const isMobile = useIsMobile();
  const { quickChat } = Route.useSearch();
  const navigate = useNavigate();
  const { hostId } = useParams({ from: "/hosts/$hostId/workspaces" });

  // Opened via the home page's Quick chat button (?quickChat=true). This route
  // is host-scoped, so the dialog's API calls + post-send navigation auto-target
  // this host. Clear the flag afterwards so refresh/back doesn't re-open it.
  useEffect(() => {
    if (!quickChat) return;
    void QuickChatDialog.show();
    void navigate({
      to: "/hosts/$hostId/workspaces",
      params: { hostId },
      search: {},
      replace: true,
    });
  }, [quickChat, hostId, navigate]);

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
      onSelectWorkspaceOverride={(id, _event, workspaceHostId) =>
        selectWorkspace(id, workspaceHostId ?? hostId)
      }
      onAddWorkspaceOverride={() =>
        navigate({
          to: "/hosts/$hostId/workspaces/create",
          params: { hostId },
        })
      }
    />
  );
}
