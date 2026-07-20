import { describe, expect, it } from "vitest";
import { hasRemoteRouteHost } from "./RemoteUserSystemProvider";

describe("RemoteUserSystemProvider", () => {
  it("loads host config only on an explicitly host-scoped route", () => {
    expect(hasRemoteRouteHost(undefined)).toBe(false);
    expect(hasRemoteRouteHost("")).toBe(false);
    expect(hasRemoteRouteHost("i9-host")).toBe(true);
  });
});
