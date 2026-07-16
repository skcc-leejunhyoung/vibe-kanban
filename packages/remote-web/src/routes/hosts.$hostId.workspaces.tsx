import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
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
  const { quickChat } = Route.useSearch();
  const navigate = useNavigate();

  // Host-scoped workspace lists are kept only as a legacy URL. The list itself
  // is global; selecting or creating a workspace carries the concrete owner
  // host from the unified picker.
  useEffect(() => {
    if (quickChat) {
      void QuickChatDialog.show();
    }
    void navigate({
      to: "/workspaces",
      replace: true,
    });
  }, [quickChat, navigate]);

  return null;
}
