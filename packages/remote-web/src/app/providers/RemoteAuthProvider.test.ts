import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { clearRemoteUserQueryCache } from "./RemoteAuthProvider";

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
