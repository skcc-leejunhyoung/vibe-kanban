import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMatchedRoutes, navigate, selectWorkspaceHost } = vi.hoisted(() => ({
  getMatchedRoutes: vi.fn(),
  navigate: vi.fn(),
  selectWorkspaceHost: vi.fn(),
}));

vi.mock("@remote/app/router", () => ({
  router: { navigate, getMatchedRoutes },
}));
vi.mock("@/shared/dialogs/command-bar/WorkspaceHostSelectionDialog", () => ({
  selectWorkspaceHost,
}));

import {
  remoteAppNavigation,
  resolveRemoteDestinationFromPath,
} from "./AppNavigation";

describe("remote pull request navigation", () => {
  beforeEach(() => {
    navigate.mockReset();
    getMatchedRoutes.mockReset();
    selectWorkspaceHost.mockReset();
  });

  it.each([
    ["/pull-requests", "/pull-requests"],
    ["/hosts/host-1/pull-requests", "/hosts/$hostId/pull-requests"],
  ])("preserves PR deep links resolved from %s", (pathname, routeId) => {
    getMatchedRoutes.mockReturnValue({
      foundRoute: { id: routeId },
      routeParams: {},
    });
    const prUrl = "https://github.com/acme/widgets/pull/42?view=files";

    expect(
      resolveRemoteDestinationFromPath(
        `${pathname}?prUrl=${encodeURIComponent(prUrl)}`,
      ),
    ).toEqual({ kind: "pull-requests", prUrl });
    expect(getMatchedRoutes).toHaveBeenCalledWith(pathname);
  });

  it("ignores workspace host selection", () => {
    remoteAppNavigation.goToPullRequests("https://example.com/pr/1", {
      hostId: "host-1",
    });

    expect(navigate).toHaveBeenCalledWith({
      to: "/pull-requests",
      search: { prUrl: "https://example.com/pr/1" },
    });
  });

  it("opens pull requests without asking for a host", () => {
    remoteAppNavigation.goToPullRequests("https://example.com/pr/2");

    expect(navigate).toHaveBeenCalledWith({
      to: "/pull-requests",
      search: { prUrl: "https://example.com/pr/2" },
    });
    expect(selectWorkspaceHost).not.toHaveBeenCalled();
  });

  it("asks for a host before opening a workspace without one", async () => {
    selectWorkspaceHost.mockResolvedValue("host-2");

    remoteAppNavigation.goToWorkspace("workspace-1");

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/hosts/$hostId/workspaces/$workspaceId",
        params: { hostId: "host-2", workspaceId: "workspace-1" },
      }),
    );
  });
});
