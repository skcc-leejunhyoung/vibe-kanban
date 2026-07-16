import { useEffect, useState } from "react";
import {
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
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
  const { workspaces, isLoading: workspacesLoading } = useUserContext();
  const [resolutionError, setResolutionError] = useState<string | null>(null);

  useEffect(() => {
    if (workspacesLoading) {
      return;
    }

    const workspace = workspaces.find(
      (candidate) =>
        candidate.local_workspace_id === workspaceId ||
        candidate.id === workspaceId,
    );
    if (!workspace?.local_workspace_id) {
      setResolutionError("Workspace not found");
      return;
    }
    if (!workspace.host_id) {
      setResolutionError("This legacy workspace has no recorded owner host");
      return;
    }

    void navigate({
      to: "/hosts/$hostId/workspaces/$workspaceId",
      params: {
        hostId: workspace.host_id,
        workspaceId: workspace.local_workspace_id,
      },
      replace: true,
    });
  }, [navigate, workspaceId, workspaces, workspacesLoading]);

  if (!resolutionError) return null;

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-high">
          Unable to open workspace
        </h1>
        <p className="mt-2 text-sm text-low">{resolutionError}</p>
      </div>
    </div>
  );
}
