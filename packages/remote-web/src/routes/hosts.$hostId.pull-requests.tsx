import { createFileRoute } from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { PullRequestsPage } from "@/pages/pull-requests/PullRequestsPage";

export const Route = createFileRoute("/hosts/$hostId/pull-requests")({
  validateSearch: (search: Record<string, unknown>) => ({
    prUrl: typeof search.prUrl === "string" ? search.prUrl : undefined,
  }),
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: PullRequestsRoute,
});

function PullRequestsRoute() {
  const { prUrl } = Route.useSearch();
  return <PullRequestsPage initialPrUrl={prUrl} />;
}
