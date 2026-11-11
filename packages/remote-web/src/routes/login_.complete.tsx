import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

const searchSchema = z.object({
  handoff_id: z.string().optional(),
  app_code: z.string().optional(),
  error: z.string().optional(),
  next: z.string().optional(),
});

export const Route = createFileRoute("/login_/complete")({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/account/complete",
      search,
    });
  },
});
