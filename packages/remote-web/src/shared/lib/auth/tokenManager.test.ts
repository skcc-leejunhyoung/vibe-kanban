import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccessTokenMock = vi.fn<() => Promise<string | null>>();
const getRefreshTokenMock = vi.fn<() => Promise<string | null>>();
const storeTokensMock =
  vi.fn<
    (
      accessToken: string,
      refreshToken: string,
      options?: { notifyAuthChange?: boolean },
    ) => Promise<void>
  >();
const clearAccessTokenMock = vi.fn<() => Promise<void>>();
const clearTokensMock = vi.fn<() => Promise<void>>();
const shouldRefreshAccessTokenMock = vi.fn<(token: string) => boolean>();
const refreshTokensMock = vi.fn<
  (refreshToken: string) => Promise<{
    access_token: string;
    refresh_token: string;
  }>
>();

vi.mock("@remote/shared/lib/auth", () => ({
  getAccessToken: () => getAccessTokenMock(),
  getRefreshToken: () => getRefreshTokenMock(),
  storeTokens: (
    accessToken: string,
    refreshToken: string,
    options?: { notifyAuthChange?: boolean },
  ) => storeTokensMock(accessToken, refreshToken, options),
  clearAccessToken: () => clearAccessTokenMock(),
  clearTokens: () => clearTokensMock(),
}));

vi.mock("shared/jwt", () => ({
  shouldRefreshAccessToken: (token: string) =>
    shouldRefreshAccessTokenMock(token),
}));

vi.mock("@remote/shared/lib/api", () => ({
  refreshTokens: (refreshToken: string) => refreshTokensMock(refreshToken),
}));

import { getToken } from "./tokenManager";

beforeEach(() => {
  vi.clearAllMocks();
  getAccessTokenMock.mockResolvedValue("expiring-access-token");
  getRefreshTokenMock.mockResolvedValue("current-refresh-token");
  shouldRefreshAccessTokenMock.mockReturnValue(true);
  refreshTokensMock.mockResolvedValue({
    access_token: "rotated-access-token",
    refresh_token: "rotated-refresh-token",
  });
});

describe("remote token refresh", () => {
  it("stores a routine token rotation without broadcasting an auth-state change", async () => {
    await expect(getToken()).resolves.toBe("rotated-access-token");

    expect(refreshTokensMock).toHaveBeenCalledWith("current-refresh-token");
    expect(storeTokensMock).toHaveBeenCalledWith(
      "rotated-access-token",
      "rotated-refresh-token",
      { notifyAuthChange: false },
    );
    expect(clearTokensMock).not.toHaveBeenCalled();
  });

  it("returns a fresh access token without rotating auth state", async () => {
    shouldRefreshAccessTokenMock.mockReturnValue(false);

    await expect(getToken()).resolves.toBe("expiring-access-token");

    expect(refreshTokensMock).not.toHaveBeenCalled();
    expect(storeTokensMock).not.toHaveBeenCalled();
  });
});
