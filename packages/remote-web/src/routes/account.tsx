import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";
import { redirectAuthenticatedToHome } from "@remote/shared/lib/route-auth";
import LoginPage from "../pages/LoginPage";

const searchSchema = z.object({
  next: z.string().optional(),
  reauthenticate: z.boolean().optional(),
});

export const Route = createFileRoute("/account")({
  validateSearch: zodValidator(searchSchema),
  beforeLoad: async ({ search }) => {
    if (!search.reauthenticate) await redirectAuthenticatedToHome();
  },
  component: LoginPage,
});
