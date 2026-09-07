import { createFileRoute, redirect } from "@tanstack/react-router";

export function legacyPullRequestsRedirectOptions(prUrl?: string) {
  return {
    to: "/pull-requests",
    search: { prUrl },
    replace: true,
  } as const;
}

export const Route = createFileRoute("/hosts/$hostId/pull-requests")({
  validateSearch: (search: Record<string, unknown>) => ({
    prUrl: typeof search.prUrl === "string" ? search.prUrl : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect(legacyPullRequestsRedirectOptions(search.prUrl));
  },
});
