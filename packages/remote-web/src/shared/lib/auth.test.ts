import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessTokensBelongToDifferentUsers,
  storeTokens,
  beginOAuthReconnect,
  endOAuthReconnect,
  getRefreshCredentials,
  applyTokenRefresh,
  clearTokens,
  getAccessToken,
  getRefreshToken,
} from "./auth";
import { getToken, triggerRefresh } from "./auth/tokenManager";
import {
  startOAuthLogin,
  finishOAuthLogin,
  cancelOAuthReconnect,
} from "./oauth";
import { clearPairedRelayHosts } from "@/shared/lib/relayPairingStorage";

vi.mock("@/shared/lib/relayPairingStorage", () => ({
  clearPairedRelayHosts: vi.fn(),
}));

let data: Map<string, unknown>;
const dispatchEvent = vi.fn();
const fetchMock = vi.fn();
const assign = vi.fn();

// Model only IDB persistence: queued requests, atomic commit/abort, and the
// shared database used by separate tabs. Auth/OAuth/token-manager code is real.
function stubAuthDB() {
  data = new Map();
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = {
        result: {
          close: () => {},
          transaction: () => {
            const operations: (() => void)[] = [];
            let pending: Map<string, unknown>;
            let aborted = false;
            const tx = {
              oncomplete: undefined as undefined | (() => void),
              onabort: undefined as undefined | (() => void),
              abort: () => {
                aborted = true;
                tx.onabort?.();
              },
              objectStore: () => ({
                get: (key: string) => {
                  const read = {
                    result: undefined as unknown,
                    onsuccess: undefined as undefined | (() => void),
                  };
                  operations.push(() => {
                    read.result = pending.get(key);
                    read.onsuccess?.();
                  });
                  return read;
                },
                put: (value: unknown, key: string) =>
                  operations.push(() => pending.set(key, value)),
                delete: (key: string) =>
                  operations.push(() => pending.delete(key)),
              }),
            };
            queueMicrotask(() => {
              pending = new Map(data);
              while (operations.length && !aborted) operations.shift()!();
              if (!aborted) {
                data.clear();
                pending.forEach((v, k) => data.set(k, v));
                tx.oncomplete?.();
              }
            });
            return tx;
          },
        },
        onsuccess: undefined as undefined | (() => void),
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
}

const tokenIssuedAt = Math.floor(Date.now() / 1000);
function token(
  subject: string,
  nonce: string,
  aud = "access",
  seconds = 3600,
): string {
  return (
    "e30." +
    Buffer.from(
      JSON.stringify({
        aud,
        sub: subject,
        exp: tokenIssuedAt + seconds,
        nonce,
      }),
    ).toString("base64url") +
    ".signature"
  );
}
const oldRefresh = () => token("user-a", "old", "refresh", 86400);
const newTokens = () => ({
  access_token: token("user-a", "renewed"),
  refresh_token: token("user-a", "renewed", "refresh", 86400),
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const initResponse = () =>
  json({
    handoff_id: "handoff",
    authorize_url: "https://github.example/oauth",
  });

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  stubAuthDB();
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", {
    dispatchEvent,
    location: { origin: "https://vibe.example", assign },
  });
  vi.stubGlobal("fetch", fetchMock);
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function seed() {
  await storeTokens(token("user-a", "old", "access", -120), oldRefresh());
  dispatchEvent.mockClear();
}

describe("accessTokensBelongToDifferentUsers", () => {
  it("keeps pairings for rotation but detects account changes and undecodable tokens", () => {
    expect(
      accessTokensBelongToDifferentUsers(
        token("user-a", "old"),
        token("user-a", "new"),
      ),
    ).toBe(false);
    expect(
      accessTokensBelongToDifferentUsers(
        token("user-a", "old"),
        token("user-b", "new"),
      ),
    ).toBe(true);
    expect(
      accessTokensBelongToDifferentUsers("old-invalid", "new-invalid"),
    ).toBe(true);
  });
});

describe("reconnect session replacement", () => {
  it("clears the old account's host pairings before publishing another account", async () => {
    await seed();
    const old = await getAccessToken();
    vi.mocked(clearPairedRelayHosts).mockImplementationOnce(async () => {
      expect(await getAccessToken()).toBe(old);
    });
    const next = token("user-b", "new");
    await storeTokens(next, token("user-b", "new", "refresh"));
    expect(clearPairedRelayHosts).toHaveBeenCalledOnce();
    expect(await getAccessToken()).toBe(next);
  });
  it.each([
    ["user-a", "user-a", true],
    ["user-b", "user-a", false],
    ["user-a", "user-b", false],
    [null, "user-a", false],
  ] as const)(
    "atomically checks existing %s and returned %s",
    async (currentUser, returnedUser, success) => {
      const existing = currentUser ? token(currentUser, "old") : null;
      const next = token(returnedUser, "new");
      data.set("access_token", existing);
      data.set("refresh_token", "old-refresh");
      const save = storeTokens(next, "new-refresh", {
        expectedUserId: "user-a",
      });
      if (success) {
        await save;
        expect(await getAccessToken()).toBe(next);
        expect(await getRefreshToken()).toBe("new-refresh");
        expect(dispatchEvent).toHaveBeenCalledOnce();
      } else {
        await expect(save).rejects.toThrow(
          "existing session has been preserved",
        );
        expect(await getAccessToken()).toBe(existing);
        expect(await getRefreshToken()).toBe("old-refresh");
        expect(dispatchEvent).not.toHaveBeenCalled();
      }
      expect(clearPairedRelayHosts).not.toHaveBeenCalled();
    },
  );

  it("keeps overlapping guards independent and bounds abandoned recovery to ten minutes", async () => {
    await seed();
    const first = await beginOAuthReconnect();
    const second = await beginOAuthReconnect();
    await endOAuthReconnect(second.id);
    await expect(getRefreshCredentials()).rejects.toMatchObject({
      status: 503,
    });
    expect(await applyTokenRefresh(first.refreshToken)).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    await expect(getRefreshCredentials()).resolves.toMatchObject({
      refreshToken: first.refreshToken,
    });
  });

  it("lets explicit logout win over a pending reconnect and any late refresh", async () => {
    await seed();
    const recovery = await beginOAuthReconnect();
    await clearTokens();
    expect(await applyTokenRefresh(recovery.refreshToken, newTokens())).toBe(
      false,
    );
    await expect(
      storeTokens(newTokens().access_token, newTokens().refresh_token, {
        expectedUserId: "user-a",
      }),
    ).rejects.toThrow("existing session has been preserved");
    expect(await getAccessToken()).toBeNull();
    expect(await getRefreshToken()).toBeNull();
    await expect(getRefreshCredentials()).resolves.toMatchObject({
      reconnects: [],
    });
  });

  it("cancels browser-back recovery without releasing another tab's guard", async () => {
    await seed();
    const otherTab = await beginOAuthReconnect();
    fetchMock.mockResolvedValue(initResponse());
    await startOAuthLogin("github", "/pull-requests", true);
    await cancelOAuthReconnect();
    expect(sessionStorage.getItem("oauth_reconnect")).toBeNull();
    expect(sessionStorage.getItem("oauth_verifier")).toBeNull();
    await expect(getRefreshCredentials()).rejects.toMatchObject({
      status: 503,
    });
    await endOAuthReconnect(otherTab.id);
    await expect(getRefreshCredentials()).resolves.toMatchObject({
      reconnects: [],
    });
  });

  it("releases only a failed initialization's guard and does not strand a rotated refresh token", async () => {
    await seed();
    let release!: (response: Response) => void;
    fetchMock.mockImplementation((url: string) =>
      url.endsWith("/tokens/refresh")
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : json({ error: "unavailable" }, 503),
    );
    const refreshing = getToken();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const other = await beginOAuthReconnect();
    release(json(newTokens()));
    await expect(refreshing).resolves.toBe(newTokens().access_token);
    await expect(
      startOAuthLogin("github", "/pull-requests", true),
    ).rejects.toThrow("OAuth init failed");
    expect(await getRefreshToken()).toBe(newTokens().refresh_token);
    await expect(getRefreshCredentials()).rejects.toMatchObject({
      status: 503,
    });
    await endOAuthReconnect(other.id);
    await expect(getRefreshCredentials()).resolves.toMatchObject({
      reconnects: [],
    });
  });

  it("preserves both credentials when an in-flight 401 arrives during reconnect init, then completes recovery", async () => {
    await seed();
    const originalAccess = await getAccessToken();
    let releaseRefresh!: (response: Response) => void;
    let releaseInit!: (response: Response) => void;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/tokens/refresh"))
        return new Promise<Response>((r) => {
          releaseRefresh = r;
        });
      if (url.endsWith("/oauth/web/reconnect"))
        return new Promise<Response>((r) => {
          releaseInit = r;
        });
      if (url.endsWith("/oauth/web/redeem"))
        return Promise.resolve(json(newTokens()));
      throw Error("unexpected request");
    });
    const refreshing = getToken().catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const initiating = startOAuthLogin("github", "/pull-requests", true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releaseRefresh(json({ error: "provider_token_revoked" }, 401));
    expect(await refreshing).toMatchObject({ status: 503 });
    expect(await getAccessToken()).toBe(originalAccess);
    expect(await getRefreshToken()).toBe(oldRefresh());
    await expect(triggerRefresh()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    releaseInit(initResponse());
    await initiating;
    await finishOAuthLogin("handoff", "code", "github");
    expect(await getToken()).toBe(newTokens().access_token);
    expect(await getRefreshToken()).toBe(newTokens().refresh_token);
    await expect(getRefreshCredentials()).resolves.toMatchObject({
      reconnects: [],
    });
    expect(clearPairedRelayHosts).not.toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });

  it.each([200, 401])(
    "ignores a late %s response after successful reconnect",
    async (status) => {
      await seed();
      let release!: (response: Response) => void;
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith("/tokens/refresh"))
          return new Promise<Response>((r) => {
            release = r;
          });
        if (url.endsWith("/oauth/web/reconnect"))
          return Promise.resolve(initResponse());
        if (url.endsWith("/oauth/web/redeem"))
          return Promise.resolve(json(newTokens()));
        throw Error("unexpected request");
      });
      const refreshing = getToken();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await startOAuthLogin("github", "/pull-requests", true);
      await finishOAuthLogin("handoff", "code", "github");
      release(
        json(
          {
            access_token: token("user-a", "stale"),
            refresh_token: "stale-refresh",
          },
          status,
        ),
      );
      await expect(refreshing).resolves.toBe(newTokens().access_token);
      expect(await getRefreshToken()).toBe(newTokens().refresh_token);
      expect(clearPairedRelayHosts).not.toHaveBeenCalled();
      expect(dispatchEvent).toHaveBeenCalledOnce();
    },
  );

  it("does not replay an old user's request under a newly signed-in account", async () => {
    await seed();
    let release!: (response: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((r) => {
        release = r;
      }),
    );
    const refreshing = getToken();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const next = token("user-b", "new");
    await storeTokens(next, token("user-b", "new", "refresh"));
    release(json({ error: "revoked" }, 401));
    await expect(refreshing).rejects.toThrow("Session changed during refresh");
    expect(await getAccessToken()).toBe(next);
  });

  it("does not retry a late API 401 under another account", async () => {
    await seed();
    const rejected = (await getAccessToken())!;
    const next = token("user-b", "new");
    await storeTokens(next, token("user-b", "new", "refresh"));
    await expect(triggerRefresh(rejected)).rejects.toThrow(
      "Session changed during refresh",
    );
    expect(await getAccessToken()).toBe(next);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still expires an unprotected revoked session", async () => {
    await seed();
    fetchMock.mockResolvedValue(json({ error: "revoked" }, 401));
    await expect(getToken()).rejects.toThrow("Session expired");
    expect(await getAccessToken()).toBeNull();
    expect(await getRefreshToken()).toBeNull();
    expect(clearPairedRelayHosts).toHaveBeenCalledOnce();
  });
});
