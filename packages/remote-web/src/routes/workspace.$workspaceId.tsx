import { useEffect } from "react";
import {
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { useRelayAppBarHosts } from "@remote/shared/hooks/useRelayAppBarHosts";
import { useAuth } from "@/shared/hooks/auth/useAuth";
import { useUserContext } from "@/shared/hooks/useUserContext";

export const Route = createFileRoute("/workspace/$workspaceId")({
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: WorkspaceAliasRoute,
});

function WorkspaceAliasRoute() {
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId" });
  const navigate = useNavigate();
  const { isSignedIn } = useAuth();
  const { hosts, isLoading: hostsLoading } = useRelayAppBarHosts(isSignedIn);
  const { workspaces, isLoading: workspacesLoading } = useUserContext();

  useEffect(() => {
    if (hostsLoading || workspacesLoading) {
      return;
    }

    const host = hosts.find((candidate) => candidate.status === "online");
    if (!host) {
      void navigate({ to: "/", replace: true });
      return;
    }

    const workspace = workspaces.find(
      (candidate) =>
        candidate.local_workspace_id === workspaceId ||
        candidate.id === workspaceId,
    );
    const localWorkspaceId = workspace?.local_workspace_id ?? workspaceId;

    void navigate({
      to: "/hosts/$hostId/workspaces/$workspaceId",
      params: { hostId: host.id, workspaceId: localWorkspaceId },
      replace: true,
    });
  }, [
    hosts,
    hostsLoading,
    navigate,
    workspaceId,
    workspaces,
    workspacesLoading,
  ]);

  return null;
}
