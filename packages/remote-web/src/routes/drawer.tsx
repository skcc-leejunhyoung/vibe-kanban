import { createFileRoute } from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { DrawerPage } from "@/pages/drawer/DrawerPage";

export const Route = createFileRoute("/drawer")({
  validateSearch: (search: Record<string, unknown>) => ({
    note: typeof search.note === "string" ? search.note : undefined,
  }),
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: DrawerRoute,
});

function DrawerRoute() {
  const { note } = Route.useSearch();
  return <DrawerPage initialNoteId={note} />;
}
