import { getAccessTokenSubject, getRefreshTokenSubject } from "shared/jwt";
import { clearPairedRelayHosts } from "@/shared/lib/relayPairingStorage";

const DB_NAME = "rf-auth";
const STORE_NAME = "tokens";
const ACCESS_TOKEN_KEY = "access_token";
const REFRESH_TOKEN_KEY = "refresh_token";
const RECONNECTS_KEY = "oauth_reconnects";
const RECONNECT_TIMEOUT_MS = 10 * 60 * 1000;
export const AUTH_CHANGED_EVENT = "remote-auth-changed";

interface StoreTokensOptions {
  /** Routine rotation must not reset React auth state or remount data sources. */
  notifyAuthChange?: boolean;
  /** Reconnect must never replace a different user's session. */
  expectedUserId?: string;
}

type Reconnect = { id: string; expiresAt: number };
type AuthSnapshot = {
  accessToken: string | null;
  refreshToken: string | null;
  reconnects: Reconnect[];
};

export class ReconnectPendingError extends Error {
  readonly status = 503;
  constructor() {
    super(
      "GitHub reconnection is in progress. Please complete it or try again later.",
    );
  }
}

export function accessTokensBelongToDifferentUsers(
  previousToken: string,
  nextToken: string,
): boolean {
  const previousSubject = getAccessTokenSubject(previousToken);
  const nextSubject = getAccessTokenSubject(nextToken);
  if (!previousSubject || !nextSubject) return previousToken !== nextToken;
  return previousSubject !== nextSubject;
}

function emitAuthChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
  }
}

// Read/compare/write within one IDB transaction, including across browser tabs.
// Callbacks stay synchronous so the transaction cannot auto-commit mid-update.
function withAuthStore<T>(
  mode: IDBTransactionMode,
  change: (store: IDBObjectStore, current: AuthSnapshot) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const access = store.get(ACCESS_TOKEN_KEY);
      const refresh = store.get(REFRESH_TOKEN_KEY);
      const reconnects = store.get(RECONNECTS_KEY);
      let result: T;
      let failure: unknown;
      reconnects.onsuccess = () => {
        try {
          result = change(store, {
            accessToken: access.result ?? null,
            refreshToken: refresh.result ?? null,
            reconnects: ((reconnects.result ?? []) as Reconnect[]).filter(
              (entry) => entry.expiresAt > Date.now(),
            ),
          });
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(failure ?? tx.error);
      };
    };
  });
}

export async function storeTokens(
  accessToken: string,
  refreshToken: string,
  { notifyAuthChange = true, expectedUserId }: StoreTokensOptions = {},
): Promise<void> {
  // Pairing keys belong to the previous account: clear them before exposing a
  // different account's tokens, preserving the ordinary login boundary.
  if (!expectedUserId) {
    const previous = await getAccessToken();
    if (previous && accessTokensBelongToDifferentUsers(previous, accessToken)) {
      await clearPairedRelayHosts();
    }
  }
  await withAuthStore("readwrite", (store, current) => {
    if (
      expectedUserId &&
      (getAccessTokenSubject(current.accessToken ?? "") !== expectedUserId ||
        getAccessTokenSubject(accessToken) !== expectedUserId)
    ) {
      throw new Error(
        "The signed-in account changed. Your existing session has been preserved.",
      );
    }
    store.put(accessToken, ACCESS_TOKEN_KEY);
    store.put(refreshToken, REFRESH_TOKEN_KEY);
    store.delete(RECONNECTS_KEY);
  });
  if (notifyAuthChange) emitAuthChanged();
}

export function getAccessToken(): Promise<string | null> {
  return withAuthStore("readonly", (_, current) => current.accessToken);
}

export function getRefreshToken(): Promise<string | null> {
  return withAuthStore("readonly", (_, current) => current.refreshToken);
}

export function beginOAuthReconnect(): Promise<{
  id: string;
  userId: string;
  refreshToken: string;
}> {
  return withAuthStore("readwrite", (store, current) => {
    const userId = current.refreshToken
      ? getRefreshTokenSubject(current.refreshToken)
      : null;
    if (
      !userId ||
      getAccessTokenSubject(current.accessToken ?? "") !== userId
    ) {
      throw new Error("Sign in before reconnecting GitHub.");
    }
    const id = crypto.randomUUID();
    store.put(
      [
        ...current.reconnects,
        { id, expiresAt: Date.now() + RECONNECT_TIMEOUT_MS },
      ],
      RECONNECTS_KEY,
    );
    return { id, userId, refreshToken: current.refreshToken! };
  });
}

export function endOAuthReconnect(id: string): Promise<void> {
  return withAuthStore("readwrite", (store, current) => {
    store.put(
      current.reconnects.filter((entry) => entry.id !== id),
      RECONNECTS_KEY,
    );
  });
}

export function getRefreshCredentials(): Promise<AuthSnapshot> {
  return withAuthStore("readonly", (_, current) => {
    if (current.reconnects.length) throw new ReconnectPendingError();
    return current;
  });
}

/** Apply only the refresh that still owns the stored credentials. */
export async function applyTokenRefresh(
  expectedRefreshToken: string,
  tokens?: { access_token: string; refresh_token: string },
): Promise<boolean> {
  const applied = await withAuthStore("readwrite", (store, current) => {
    if (
      current.refreshToken !== expectedRefreshToken ||
      (!tokens && current.reconnects.length)
    )
      return false;
    if (tokens) {
      if (
        current.accessToken &&
        accessTokensBelongToDifferentUsers(
          current.accessToken,
          tokens.access_token,
        )
      )
        return false;
      store.put(tokens.access_token, ACCESS_TOKEN_KEY);
      store.put(tokens.refresh_token, REFRESH_TOKEN_KEY);
    } else {
      store.delete(ACCESS_TOKEN_KEY);
      store.delete(REFRESH_TOKEN_KEY);
      store.delete(RECONNECTS_KEY);
    }
    return true;
  });
  if (applied && !tokens) {
    try {
      await clearPairedRelayHosts();
    } finally {
      emitAuthChanged();
    }
  }
  return applied;
}

/** Explicit logout always wins, even during reconnect. */
export async function clearTokens(): Promise<void> {
  try {
    await withAuthStore("readwrite", (store) => {
      store.delete(ACCESS_TOKEN_KEY);
      store.delete(REFRESH_TOKEN_KEY);
      store.delete(RECONNECTS_KEY);
    });
    await clearPairedRelayHosts();
  } finally {
    emitAuthChanged();
  }
}

export function isLoggedIn(): Promise<boolean> {
  return withAuthStore(
    "readonly",
    (_, current) =>
      current.accessToken !== null && current.refreshToken !== null,
  );
}
