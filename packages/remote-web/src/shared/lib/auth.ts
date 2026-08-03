import { getAccessTokenSubject } from "shared/jwt";
import { clearPairedRelayHosts } from "@/shared/lib/relayPairingStorage";

const DB_NAME = "rf-auth";
const STORE_NAME = "tokens";
const ACCESS_TOKEN_KEY = "access_token";
const REFRESH_TOKEN_KEY = "refresh_token";
export const AUTH_CHANGED_EVENT = "remote-auth-changed";

interface StoreTokensOptions {
  /**
   * Notify React auth state that the signed-in session changed.
   *
   * Token rotation for the same session must keep this false: resetting the
   * identity query briefly marks the app signed out and remounts host-scoped
   * data every time the short-lived access token is refreshed.
   */
  notifyAuthChange?: boolean;
}

export function accessTokensBelongToDifferentUsers(
  previousToken: string,
  nextToken: string,
): boolean {
  const previousSubject = getAccessTokenSubject(previousToken);
  const nextSubject = getAccessTokenSubject(nextToken);
  if (!previousSubject || !nextSubject) {
    return previousToken !== nextToken;
  }
  return previousSubject !== nextSubject;
}

function emitAuthChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function get(key: string): Promise<string | null> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        let value: string | null = null;
        const req = tx.objectStore(STORE_NAME).get(key);

        req.onsuccess = () => {
          value = (req.result as string) ?? null;
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

function put(key: string, value: string): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).put(value, key);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

function del(key: string): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).delete(key);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export async function storeTokens(
  accessToken: string,
  refreshToken: string,
  { notifyAuthChange = true }: StoreTokensOptions = {},
): Promise<void> {
  const previousAccessToken = await getAccessToken();
  if (
    previousAccessToken &&
    accessTokensBelongToDifferentUsers(previousAccessToken, accessToken)
  ) {
    await clearPairedRelayHosts();
  }
  await put(ACCESS_TOKEN_KEY, accessToken);
  await put(REFRESH_TOKEN_KEY, refreshToken);
  if (notifyAuthChange) {
    emitAuthChanged();
  }
}

export function getAccessToken(): Promise<string | null> {
  return get(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): Promise<string | null> {
  return get(REFRESH_TOKEN_KEY);
}

export async function clearAccessToken(): Promise<void> {
  await del(ACCESS_TOKEN_KEY);
}

export async function clearTokens(): Promise<void> {
  try {
    await Promise.all([
      del(ACCESS_TOKEN_KEY),
      del(REFRESH_TOKEN_KEY),
      clearPairedRelayHosts(),
    ]);
  } finally {
    emitAuthChanged();
  }
}

export async function isLoggedIn(): Promise<boolean> {
  const [access, refresh] = await Promise.all([
    getAccessToken(),
    getRefreshToken(),
  ]);
  return access !== null && refresh !== null;
}
