import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAccessToken,
  getRefreshCredentials,
  applyTokenRefresh,
  refreshTokens,
  shouldRefresh,
} = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getRefreshCredentials: vi.fn(),
  applyTokenRefresh: vi.fn(),
  refreshTokens: vi.fn(),
  shouldRefresh: vi.fn(),
}));
vi.mock("@remote/shared/lib/auth", () => ({
  getAccessToken,
  getRefreshCredentials,
  applyTokenRefresh,
  accessTokensBelongToDifferentUsers: () => false,
}));
vi.mock("shared/jwt", () => ({ shouldRefreshAccessToken: shouldRefresh }));
vi.mock("@remote/shared/lib/api", () => ({ refreshTokens }));
import { getToken, triggerRefresh } from "./tokenManager";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("navigator", {});
  getAccessToken.mockResolvedValue("expiring-access");
  getRefreshCredentials.mockResolvedValue({
    accessToken: "expiring-access",
    refreshToken: "current-refresh",
  });
  shouldRefresh.mockReturnValue(true);
  applyTokenRefresh.mockResolvedValue(true);
  refreshTokens.mockResolvedValue({
    access_token: "rotated-access",
    refresh_token: "rotated-refresh",
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("remote token refresh", () => {
  it("uses the conditional rotation path without changing signed-in state", async () => {
    await expect(getToken()).resolves.toBe("rotated-access");
    expect(refreshTokens).toHaveBeenCalledWith("current-refresh");
    expect(applyTokenRefresh).toHaveBeenCalledWith("current-refresh", {
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
    });
  });
  it("returns fresh access without rotation", async () => {
    shouldRefresh.mockReturnValue(false);
    await expect(getToken()).resolves.toBe("expiring-access");
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(applyTokenRefresh).not.toHaveBeenCalled();
  });
  it("forces a rejected fresh token to rotate without deleting its identity", async () => {
    shouldRefresh.mockReturnValue(false);
    await expect(triggerRefresh("expiring-access")).resolves.toBe(
      "rotated-access",
    );
    expect(refreshTokens).toHaveBeenCalledOnce();
  });
  it("does not rotate a renewed token for a late 401 of an older request", async () => {
    shouldRefresh.mockReturnValue(false);
    await expect(triggerRefresh("previous-access")).resolves.toBe(
      "expiring-access",
    );
    expect(refreshTokens).not.toHaveBeenCalled();
  });
  it("does not clear credentials on non-revocation errors", async () => {
    refreshTokens.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );
    await expect(getToken()).rejects.toThrow("Forbidden");
    expect(applyTokenRefresh).not.toHaveBeenCalled();
  });
});
