import {
  getAccessToken,
  getRefreshCredentials,
  applyTokenRefresh,
} from "@remote/shared/lib/auth";
import {
  accessTokensBelongToDifferentUsers,
  shouldRefreshAccessToken,
} from "shared/jwt";
import { refreshTokens } from "@remote/shared/lib/api";

const TOKEN_REFRESH_TIMEOUT_MS = 80_000;
const TOKEN_REFRESH_MAX_ATTEMPTS = 3;

async function refreshWithRetry(refreshToken: string) {
  for (let attempt = 1; attempt <= TOKEN_REFRESH_MAX_ATTEMPTS; attempt++) {
    const backoffMs = Math.min(500 * 2 ** (attempt - 1), 2000);
    let timeoutId: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        refreshTokens(refreshToken),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Token refresh timed out")),
            TOKEN_REFRESH_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      const isTimeout =
        error instanceof Error && error.message === "Token refresh timed out";
      if (isTimeout) throw error;

      const status = (error as { status?: number }).status;
      const isRetryable =
        !status || status >= 500 || error instanceof TypeError;
      if (isRetryable && attempt < TOKEN_REFRESH_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId!);
    }
  }
  throw new Error("Token refresh failed after retries");
}

let refreshPromise: Promise<string> | null = null;

async function doTokenRefresh(
  rejectedAccessToken?: string | null,
): Promise<string> {
  const { accessToken: current, refreshToken } = await getRefreshCredentials();
  if (
    rejectedAccessToken &&
    current &&
    accessTokensBelongToDifferentUsers(rejectedAccessToken, current)
  ) {
    throw new Error("Session changed during refresh. Please try again.");
  }
  if (
    current &&
    current !== rejectedAccessToken &&
    !shouldRefreshAccessToken(current)
  )
    return current;
  if (!refreshToken) {
    throw new Error("No refresh token available");
  }

  try {
    const tokens = await refreshWithRetry(refreshToken);
    if (await applyTokenRefresh(refreshToken, tokens))
      return tokens.access_token;
  } catch (error) {
    // Network/5xx failures do not prove revocation. A late 401 may only clear
    // the credential it used, and never one protected by an active reconnect.
    if ((error as { status?: number }).status === 401) {
      if (await applyTokenRefresh(refreshToken)) {
        throw new Error("Session expired. Please sign in again.");
      }
    } else {
      throw error;
    }
  }
  const latest = await getRefreshCredentials();
  if (
    current &&
    latest.accessToken &&
    latest.refreshToken !== refreshToken &&
    !accessTokensBelongToDifferentUsers(current, latest.accessToken) &&
    !shouldRefreshAccessToken(latest.accessToken)
  )
    return latest.accessToken;
  throw new Error("Session changed during refresh. Please try again.");
}

async function handleTokenRefresh(
  rejectedAccessToken?: string | null,
): Promise<string> {
  if (!refreshPromise) {
    const innerPromise =
      typeof navigator.locks?.request === "function"
        ? navigator.locks
            .request("rf-token-refresh", () =>
              doTokenRefresh(rejectedAccessToken),
            )
            .then((token) => token)
        : doTokenRefresh(rejectedAccessToken);

    refreshPromise = innerPromise.finally(() => {
      refreshPromise = null;
    });
  }
  const token = await refreshPromise;
  // A shared refresh may belong to a different account than this caller.
  // Check every result, not only the caller that started doTokenRefresh.
  if (
    rejectedAccessToken &&
    accessTokensBelongToDifferentUsers(rejectedAccessToken, token)
  ) {
    throw new Error("Session changed during refresh. Please try again.");
  }
  return token;
}

export async function getToken(): Promise<string> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return handleTokenRefresh();
  }
  if (shouldRefreshAccessToken(accessToken))
    return handleTokenRefresh(accessToken);
  return accessToken;
}

export async function triggerRefresh(
  rejectedAccessToken?: string,
): Promise<string> {
  // Keep the initiating identity intact for reconnect and compare late 401s
  // against the token actually rejected, instead of deleting current access.
  return handleTokenRefresh(rejectedAccessToken ?? (await getAccessToken()));
}
