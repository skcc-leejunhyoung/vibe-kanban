import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRemoteUserQueryCache,
  RemoteAuthProvider,
} from "./RemoteAuthProvider";

const queryOptions = vi.hoisted(
  () => [] as Array<{ queryKey: readonly unknown[]; enabled?: boolean }>,
);
vi.mock("@tanstack/react-query", async (original) => {
  const real = await original<typeof import("@tanstack/react-query")>();
  return {
    ...real,
    useQuery: (options: Parameters<typeof real.useQuery>[0]) => {
      queryOptions.push({
        queryKey: options.queryKey,
        enabled:
          typeof options.enabled === "boolean" ? options.enabled : undefined,
      });
      return real.useQuery(options);
    },
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  queryOptions.length = 0;
});

describe("clearRemoteUserQueryCache", () => {
  it("removes user-scoped queries while retaining auth state", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["remote-auth", "tokens"], true);
    queryClient.setQueryData(["relay-remote-hosts"], [{ id: "host-a" }]);
    queryClient.setQueryData(["workspace-summaries", "host-a"], ["private"]);

    clearRemoteUserQueryCache(queryClient);

    expect(queryClient.getQueryData(["remote-auth", "tokens"])).toBe(true);
    expect(queryClient.getQueryData(["relay-remote-hosts"])).toBeUndefined();
    expect(
      queryClient.getQueryData(["workspace-summaries", "host-a"]),
    ).toBeUndefined();
  });
});

it.each(["/account/complete", "/pull-requests"])(
  "gates background token refresh on %s",
  (pathname) => {
    vi.stubGlobal("window", { location: { pathname } });
    const client = new QueryClient();
    client.setQueryData(["remote-auth", "tokens"], true);
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RemoteAuthProvider, { children: null }),
      ),
    );
    const identity = queryOptions.find(
      ({ queryKey }) => queryKey[1] === "identity",
    );
    expect(identity?.enabled).toBe(pathname !== "/account/complete");
    client.clear();
  },
);
