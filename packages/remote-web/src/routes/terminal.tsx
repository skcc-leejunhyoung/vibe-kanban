import { createFileRoute } from "@tanstack/react-router";
import { HomeTerminalPanel } from "@/shared/components/TerminalPanelContainer";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";

export const Route = createFileRoute("/terminal")({
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: HomeTerminalPanel,
});
