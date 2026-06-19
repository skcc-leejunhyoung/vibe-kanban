import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirror the path aliases declared in vite.config.ts so unit tests resolve
// `@remote/*` (src), `@/*` (web-core src) and `shared/*` (generated TS types)
// the same way the app build does.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@remote",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
      {
        find: /^@\//,
        replacement: `${fileURLToPath(new URL("../web-core/src", import.meta.url))}/`,
      },
      {
        find: "shared",
        replacement: fileURLToPath(new URL("../../shared", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
