import { createFileRoute } from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { PullRequestsPage } from "@/pages/pull-requests/PullRequestsPage";

export const Route = createFileRoute("/hosts/$hostId/pull-requests")({
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: PullRequestsPage,
});
