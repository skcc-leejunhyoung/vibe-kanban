import { useEffect, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import WorkspacesUnavailablePage from "@remote/pages/WorkspacesUnavailablePage";
import { useRelayWorkspaceHostHealth } from "@remote/shared/hooks/useRelayWorkspaceHostHealth";
import { useWorkspaceContext } from "@/shared/hooks/useWorkspaceContext";
import { useMobileWorkspaceTitle } from "@remote/shared/stores/useMobileWorkspaceTitle";
import { Workspaces } from "@/pages/workspaces/Workspaces";

interface RemoteWorkspacesPageShellProps {
  children: ReactNode;
}

function WorkspaceTitleSync() {
  const { workspace } = useWorkspaceContext();
  const setTitle = useMobileWorkspaceTitle((s) => s.setTitle);

  useEffect(() => {
    setTitle(workspace?.name ?? workspace?.branch ?? null);
    return () => setTitle(null);
  }, [workspace?.name, workspace?.branch, setTitle]);

  return null;
}

/**
 * Shared chrome for the remote workspace surface. It keeps the mobile title in
 * sync while the unified sidebar + detail render underneath.
 *
 * It deliberately does NOT gate the whole page on a single host's health.
 * Doing so blanked the unified multi-host list whenever the *opened*
 * workspace's host was briefly checking or offline, which made the "All hosts"
 * list feel like a per-host page in disguise. Host-unavailability is surfaced
 * only in the detail pane instead — see {@link HostGatedWorkspaces}.
 */
export function RemoteWorkspacesPageShell({
  children,
}: RemoteWorkspacesPageShellProps) {
  const { hostId } = useParams({ strict: false });

  if (!hostId) {
    return <>{children}</>;
  }

  return (
    <>
      <WorkspaceTitleSync />
      {children}
    </>
  );
}

/**
 * Renders the unified workspace list + detail for a host-scoped route. If that
 * host is unreachable, only the detail pane is replaced with the unavailable
 * notice; the multi-host sidebar keeps streaming every other online host, and
 * the host selector keeps whatever scope the user chose.
 */
export function HostGatedWorkspaces({ hostId }: { hostId: string }) {
  const hostHealth = useRelayWorkspaceHostHealth(hostId);

  // Only a confirmed failure gates the detail. While the probe is still pending
  // we render the workspace normally — its data streams over the same relay and
  // paints without a full-page "connecting…" flash on every cross-host open.
  const detailUnavailable = hostHealth.isError ? (
    <WorkspacesUnavailablePage
      blockedHost={{
        id: hostId,
        name: null,
        errorMessage: hostHealth.errorMessage,
      }}
    />
  ) : undefined;

  return (
    <RemoteWorkspacesPageShell>
      <Workspaces detailUnavailable={detailUnavailable} />
    </RemoteWorkspacesPageShell>
  );
}
