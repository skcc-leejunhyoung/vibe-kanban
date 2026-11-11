import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import HomePage from "../pages/HomePage";

const searchSchema = z.object({
  legacyOrgSettingsOrgId: z.string().optional(),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  component: HomePage,
});
