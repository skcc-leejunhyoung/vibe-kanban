import { createHash } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthDialog } from "@/shared/dialogs/global/OAuthDialog";
import { GitHubApiErrorAlert } from "@/shared/components/GitHubApiErrorAlert";
import { configureAuthRuntime } from "@/shared/lib/auth/runtime";
import { setLocalApiTransport } from "@/shared/lib/localApiTransport";
import { RemoteApiError } from "@/shared/lib/remoteApi";
import { requestLocalApiViaRelay } from "@remote/shared/lib/relayHostApi";
import {
  getAccessToken,
  getRefreshToken,
  storeTokens,
  clearTokens,
  beginOAuthReconnect,
  endOAuthReconnect,
} from "./auth";
import { getRefreshTokenSubject } from "shared/jwt";
import { retrieveVerifier } from "./pkce";
import { finishOAuthLogin, redirectToOAuth, startOAuthLogin } from "./oauth";

// Keep the real token manager/API: mocking getToken hid the expired-provider
// refresh that used to clear the session before OAuth could start.
vi.mock("./auth", () => ({
  getAccessToken: vi.fn(),
  getRefreshToken: vi.fn(),
  storeTokens: vi.fn(),
  clearTokens: vi.fn(),
  clearAccessToken: vi.fn(),
  beginOAuthReconnect: vi.fn(),
  endOAuthReconnect: vi.fn(),
}));

const tokenIssuedAt = Math.floor(Date.now() / 1000);
const token = (user: string, aud = "access", seconds = 120) =>
  `e30.${Buffer.from(JSON.stringify({ aud, sub: user, exp: tokenIssuedAt + seconds })).toString("base64url")}.signature`;
const refreshToken = token("user-1", "refresh", 86400);

const { showLocalModal, action } = vi.hoisted(() => ({
  showLocalModal: vi.fn(),
  action: { reconnect: undefined as undefined | (() => Promise<void>) },
}));
vi.mock("@ebay/nice-modal-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ebay/nice-modal-react")>()),
  show: showLocalModal,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...original,
    useMutation: (options: { mutationFn: () => Promise<void> }) => {
      action.reconnect = options.mutationFn;
      return original.useMutation(options);
    },
  };
});

const runtime = {
  getToken: async () => "existing-session",
  triggerRefresh: async () => null,
  registerShape: () => () => {},
  getCurrentUser: async () => ({ user_id: "user-1" }),
};
const fetchMock = vi.fn();
const assign = vi.fn();
const hostRequest = vi.fn(requestLocalApiViaRelay);
const next =
  "/pull-requests?prUrl=https%3A%2F%2Fgithub.com%2Facme%2Frepo%2Fpull%2F42#discussion";
const authorizeUrl = "https://github.com/login/oauth/authorize?state=handoff";

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.mocked(getRefreshToken).mockResolvedValue(refreshToken);
  vi.mocked(getAccessToken).mockResolvedValue(token("user-1"));
  vi.mocked(storeTokens).mockResolvedValue();
  vi.mocked(beginOAuthReconnect).mockImplementation(async () => {
    const credential = await getRefreshToken();
    const userId = credential ? getRefreshTokenSubject(credential) : null;
    if (!credential || !userId)
      throw new Error("Sign in before reconnecting GitHub.");
    return { id: "recovery-1", userId, refreshToken: credential };
  });
  vi.mocked(endOAuthReconnect).mockResolvedValue();
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("window", {
    location: Object.assign(new URL(next, "https://remote.example"), {
      assign,
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", {});
  configureAuthRuntime({ ...runtime, redirectToOAuth });
  setLocalApiTransport({
    request: hostRequest,
    openWebSocket: () => {
      throw new Error("Unexpected host websocket");
    },
  });
});

afterEach(() => {
  configureAuthRuntime(runtime);
  setLocalApiTransport(null);
  vi.unstubAllGlobals();
});

function successfulInit() {
  return new Response(
    JSON.stringify({ handoff_id: "handoff-1", authorize_url: authorizeUrl }),
  );
}

describe("hostless OAuth recovery", () => {
  it.each([15, -120])(
    "starts and retries recovery with %s seconds of access lifetime without ordinary refresh",
    async (seconds) => {
      vi.mocked(getAccessToken).mockResolvedValue(
        token("user-1", "access", seconds),
      );
      fetchMock.mockImplementation(async (url: string) =>
        url === "/v1/tokens/refresh"
          ? new Response(JSON.stringify({ error: "provider_token_revoked" }), {
              status: 401,
            })
          : successfulInit(),
      );
      await startOAuthLogin("github", next, true);
      // The callback's Try again uses the same entry point after access expires.
      vi.mocked(getAccessToken).mockResolvedValue(
        token("user-1", "access", -300),
      );
      await startOAuthLogin("github", next, true);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "/v1/oauth/web/reconnect",
        "/v1/oauth/web/reconnect",
      ]);
      expect(assign).toHaveBeenCalledTimes(2);
      expect(
        JSON.parse(sessionStorage.getItem("oauth_reconnect")!),
      ).toMatchObject({ userId: "user-1" });
      expect(clearTokens).not.toHaveBeenCalled();
      expect(storeTokens).not.toHaveBeenCalled();
    },
  );

  it.each([null, "invalid", token("user-1")])(
    "does not downgrade reconnect to ordinary login with an unusable refresh credential (%s)",
    async (credential) => {
      vi.mocked(getRefreshToken).mockResolvedValue(credential);
      await expect(startOAuthLogin("github", next, true)).rejects.toThrow(
        "Sign in before reconnecting",
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      expect(clearTokens).not.toHaveBeenCalled();
    },
  );

  it("preserves credentials, pairing and the previous handoff when the refresh session is rejected", async () => {
    sessionStorage.setItem("oauth_verifier", "previous-verifier");
    sessionStorage.setItem("oauth_reconnect", "previous-context");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(startOAuthLogin("github", next, true)).rejects.toThrow(
      "Please sign in again",
    );
    expect(clearTokens).not.toHaveBeenCalled();
    expect(storeTokens).not.toHaveBeenCalled();
    expect(retrieveVerifier()).toBe("previous-verifier");
    expect(sessionStorage.getItem("oauth_reconnect")).toBe("previous-context");
    expect(assign).not.toHaveBeenCalled();
  });

  it("runs the real reconnect action through central PKCE and preserves the PR deep link", async () => {
    fetchMock.mockResolvedValueOnce(successfulInit());
    const client = new QueryClient();
    client.setQueryData(["github-repositories"], []);
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <GitHubApiErrorAlert
          error={new RemoteApiError("Reconnect", 424, "github_auth_required")}
          fallback="Failed to load PR"
        />
      </QueryClientProvider>,
    );

    await action.reconnect!();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/v1/oauth/web/reconnect");
    expect(init.headers.Authorization).toBe(`Bearer ${refreshToken}`);
    const payload = JSON.parse(init.body);
    expect(payload.provider).toBe("github");
    const callback = new URL(payload.return_to);
    expect(callback.origin + callback.pathname).toBe(
      "https://remote.example/account/complete",
    );
    expect(callback.searchParams.get("next")).toBe(next);
    expect(callback.searchParams.get("reconnect")).toBe("github");
    const verifier = retrieveVerifier()!;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payload.app_challenge).toBe(
      createHash("sha256").update(verifier).digest("hex"),
    );
    expect(assign).toHaveBeenCalledWith(authorizeUrl);
    expect(showLocalModal).not.toHaveBeenCalled();
    expect(hostRequest).not.toHaveBeenCalled();
    // Leaving for OAuth is not success: no cache refresh or mutation replay yet.
    expect(client.getQueryState(["github-repositories"])?.isInvalidated).toBe(
      false,
    );

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: token("user-1"),
          refresh_token: "new-refresh",
        }),
      ),
    );
    await expect(
      finishOAuthLogin("handoff-1", "app-code", "github"),
    ).resolves.toBeUndefined();
    expect(storeTokens).toHaveBeenCalledWith(token("user-1"), "new-refresh", {
      expectedUserId: "user-1",
    });
    expect(retrieveVerifier()).toBeNull();
    expect(fetchMock.mock.calls[1][0]).toBe("/v1/oauth/web/redeem");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      handoff_id: "handoff-1",
      app_code: "app-code",
      app_verifier: verifier,
    });
    expect(hostRequest).not.toHaveBeenCalled();
    client.clear();
  });

  it("keeps the session in place on init failure and allows retry", async () => {
    sessionStorage.setItem("oauth_verifier", "previous-handoff");
    sessionStorage.setItem("oauth_reconnect", "previous-context");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(
      OAuthDialog.show({ initialProvider: "github", reauthenticate: true }),
    ).rejects.toThrow("OAuth init failed (503)");
    expect(assign).not.toHaveBeenCalled();
    expect(retrieveVerifier()).toBe("previous-handoff");
    expect(sessionStorage.getItem("oauth_reconnect")).toBe("previous-context");
    expect(showLocalModal).not.toHaveBeenCalled();
    expect(hostRequest).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(successfulInit());
    await expect(
      OAuthDialog.show({ initialProvider: "github", reauthenticate: true }),
    ).resolves.toBeNull();
    expect(assign).toHaveBeenCalledWith(authorizeUrl);
  });

  it("routes generic sign-in to the remote account page", async () => {
    await expect(OAuthDialog.show({})).resolves.toBeNull();
    const target = new URL(assign.mock.calls[0][0], window.location.origin);
    expect(target.pathname).toBe("/account");
    expect(target.searchParams.get("next")).toBe(next);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hostRequest).not.toHaveBeenCalled();
    expect(showLocalModal).not.toHaveBeenCalled();
  });

  it("reuses the same PKCE flow for ordinary login", async () => {
    fetchMock.mockResolvedValueOnce(successfulInit());
    await startOAuthLogin("google");
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.provider).toBe("google");
    expect(fetchMock.mock.calls[0][0]).toBe("/v1/oauth/web/init");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(payload.return_to).toBe("https://remote.example/account/complete");
    expect(assign).toHaveBeenCalledWith(authorizeUrl);
  });

  it("keeps ordinary login completion independent of an existing user", async () => {
    sessionStorage.setItem("oauth_verifier", "verifier");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: token("user-2"),
          refresh_token: "refresh",
        }),
      ),
    );
    await finishOAuthLogin("login-handoff", "code");
    expect(storeTokens).toHaveBeenCalledWith(
      token("user-2"),
      "refresh",
      undefined,
    );
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("does not remove a newer handoff's verifier after an older completion", async () => {
    fetchMock.mockResolvedValueOnce(successfulInit());
    await startOAuthLogin("github", next, true);
    fetchMock.mockImplementationOnce(async () => {
      sessionStorage.setItem("oauth_verifier", "newer-verifier");
      sessionStorage.setItem("oauth_reconnect", "newer-context");
      return new Response(
        JSON.stringify({
          access_token: token("user-1"),
          refresh_token: "refresh",
        }),
      );
    });
    await finishOAuthLogin("handoff-1", "code", "github");
    expect(retrieveVerifier()).toBe("newer-verifier");
    expect(sessionStorage.getItem("oauth_reconnect")).toBe("newer-context");
  });

  it.each([
    "missing-context",
    "different-user",
    "different-handoff",
    "missing-verifier",
    "missing-marker",
  ])("does not redeem or replace a session after %s", async (scenario) => {
    fetchMock.mockResolvedValueOnce(successfulInit());
    await startOAuthLogin("github", next, true);
    if (scenario === "missing-context")
      sessionStorage.removeItem("oauth_reconnect");
    if (scenario === "missing-verifier")
      sessionStorage.removeItem("oauth_verifier");
    if (scenario === "different-user")
      vi.mocked(getAccessToken).mockResolvedValue(token("user-2"));
    await expect(
      finishOAuthLogin(
        scenario === "different-handoff" ? "other-handoff" : "handoff-1",
        "code",
        scenario === "missing-marker" ? undefined : "github",
      ),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storeTokens).not.toHaveBeenCalled();
  });

  it("keeps the existing session and error contract on account mismatch", async () => {
    fetchMock.mockResolvedValueOnce(successfulInit());
    await startOAuthLogin("github", next, true);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "account_mismatch" }), {
        status: 409,
      }),
    );
    await expect(
      finishOAuthLogin("handoff-1", "code", "github"),
    ).rejects.toThrow("Your current account has not changed");
    expect(storeTokens).not.toHaveBeenCalled();
  });

  it.each([true, null])(
    "preserves the local dialog result %s",
    async (result) => {
      configureAuthRuntime(runtime);
      showLocalModal.mockResolvedValueOnce(result);
      const props = {
        initialProvider: "github" as const,
        reauthenticate: true,
      };
      await expect(OAuthDialog.show(props)).resolves.toBe(result);
      expect(showLocalModal).toHaveBeenCalledWith(OAuthDialog, props);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
    },
  );
});
