import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

const searchSchema = z.object({
  next: z.string().optional(),
});

export const Route = createFileRoute("/login")({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/account",
      search: search.next ? { next: search.next } : undefined,
    });
  },
});
