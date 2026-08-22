import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigate, selectWorkspaceHost } = vi.hoisted(() => ({
  navigate: vi.fn(),
  selectWorkspaceHost: vi.fn(),
}));

vi.mock("@remote/app/router", () => ({
  router: { navigate, getMatchedRoutes: vi.fn() },
}));
vi.mock("@/shared/dialogs/command-bar/WorkspaceHostSelectionDialog", () => ({
  selectWorkspaceHost,
}));

import { remoteAppNavigation } from "./AppNavigation";

describe("remote pull request navigation", () => {
  beforeEach(() => {
    navigate.mockReset();
    selectWorkspaceHost.mockReset();
  });

  it("uses the supplied host", () => {
    remoteAppNavigation.goToPullRequests("https://example.com/pr/1", {
      hostId: "host-1",
    });

    expect(navigate).toHaveBeenCalledWith({
      to: "/hosts/$hostId/pull-requests",
      params: { hostId: "host-1" },
      search: { prUrl: "https://example.com/pr/1" },
    });
  });

  it("asks for a host when a notification does not contain one", async () => {
    selectWorkspaceHost.mockResolvedValue("host-2");

    remoteAppNavigation.goToPullRequests("https://example.com/pr/2");

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/hosts/$hostId/pull-requests",
        params: { hostId: "host-2" },
        search: { prUrl: "https://example.com/pr/2" },
      }),
    );
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
