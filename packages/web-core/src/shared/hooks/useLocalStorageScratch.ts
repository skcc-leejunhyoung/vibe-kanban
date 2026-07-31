import { useCallback, useEffect, useState } from 'react';
import type { ScratchType, Scratch, UpdateScratch } from 'shared/types';
import type { UseScratchResult } from './useScratch';

const STORAGE_PREFIX = 'vk-scratch-user';
const LEGACY_STORAGE_PREFIX = 'vk-scratch:';
const SCRATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function buildStorageKey(
  userId: string,
  scratchType: ScratchType,
  id: string
): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${scratchType}:${id}`;
}

function readFromStorage(key: string): Scratch | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const scratch = JSON.parse(raw) as Scratch;
    const updatedAt = Date.parse(scratch.updated_at);
    if (
      !Number.isFinite(updatedAt) ||
      Date.now() - updatedAt > SCRATCH_TTL_MS
    ) {
      localStorage.removeItem(key);
      return null;
    }
    return scratch;
  } catch {
    return null;
  }
}

function writeToStorage(key: string, scratch: Scratch): void {
  try {
    localStorage.setItem(key, JSON.stringify(scratch));
  } catch {
    // Quota exceeded or unavailable — silently drop the write
  }
}

function removeFromStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore errors
  }
}

/**
 * Whether the scratch should report as still loading (as opposed to "loaded,
 * and empty"). It loads while the scratch is active (`optionsEnabled`) but the
 * effective storage key hasn't been read yet — which includes the window where
 * `userId` is still unresolved and `storageKey` is empty. Reporting `true` here
 * keeps consumers that latch on the first non-loading state (e.g.
 * `useUiPreferencesScratch`) from initializing against empty data and then
 * overwriting the persisted value once the real userId arrives.
 */
export function computeScratchIsLoading(
  optionsEnabled: boolean,
  loadedKey: string | null,
  storageKey: string
): boolean {
  return optionsEnabled && loadedKey !== storageKey;
}

function buildScratchEntry(
  id: string,
  update: UpdateScratch,
  existing: Scratch | null
): Scratch {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? id,
    payload: update.payload,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

export function localStorageScratchUpdate(
  userId: string,
  scratchType: ScratchType,
  id: string,
  update: UpdateScratch
): boolean {
  if (!userId) return false;
  const key = buildStorageKey(userId, scratchType, id);
  const previousRaw = (() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  })();

  const next = buildScratchEntry(id, update, readFromStorage(key));
  const nextRaw = JSON.stringify(next);

  try {
    localStorage.setItem(key, nextRaw);
  } catch {
    return false;
  }

  try {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key,
        oldValue: previousRaw,
        newValue: nextRaw,
        storageArea: localStorage,
      })
    );
  } catch {}

  return true;
}

export function clearLocalStorageScratchForUser(userId: string): void {
  if (!userId) return;
  const prefix = `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:`;
  removeStorageKeysWithPrefix(prefix);
}

export function clearLegacyLocalStorageScratch(): void {
  removeStorageKeysWithPrefix(LEGACY_STORAGE_PREFIX);
}

function removeStorageKeysWithPrefix(prefix: string): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index)
    ).filter((key): key is string => key?.startsWith(prefix) === true);
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Ignore unavailable storage.
  }
}

interface UseLocalStorageScratchOptions {
  enabled?: boolean;
}

/**
 * localStorage-backed scratch storage for remote-web.
 * Mirrors the same interface as the WebSocket-based `useScratch` hook
 * so consumers can swap between them transparently.
 */
export const useLocalStorageScratch = (
  userId: string | null,
  scratchType: ScratchType,
  id: string,
  options?: UseLocalStorageScratchOptions
): UseScratchResult => {
  // The caller-controlled switch: whether this scratch is active at all.
  const optionsEnabled = (options?.enabled ?? true) && id.length > 0;
  // Whether we can actually read/write yet — requires a resolved userId.
  const enabled = optionsEnabled && userId !== null;
  const storageKey = userId ? buildStorageKey(userId, scratchType, id) : '';

  const [scratch, setScratch] = useState<Scratch | null>(() =>
    enabled ? readFromStorage(storageKey) : null
  );
  const [loadedKey, setLoadedKey] = useState<string | null>(
    enabled ? storageKey : null
  );

  useEffect(() => {
    if (!enabled) {
      setScratch(null);
      setLoadedKey(null);
      return;
    }

    const stored = readFromStorage(storageKey);
    setScratch(stored);
    setLoadedKey(storageKey);
  }, [storageKey, enabled]);

  useEffect(() => {
    if (!enabled) return;

    function onStorage(e: StorageEvent) {
      if (e.key !== storageKey) return;
      if (e.newValue === null) {
        setScratch(null);
      } else {
        try {
          setScratch(JSON.parse(e.newValue) as Scratch);
        } catch {
          // corrupt value — ignore
        }
      }
    }

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey, enabled]);

  const updateScratch = useCallback(
    async (update: UpdateScratch) => {
      const next = buildScratchEntry(id, update, readFromStorage(storageKey));
      writeToStorage(storageKey, next);
      setScratch(next);
    },
    [storageKey, id]
  );

  const deleteScratch = useCallback(async () => {
    removeFromStorage(storageKey);
    setScratch(null);
  }, [storageKey]);

  return {
    scratch,
    isLoading: computeScratchIsLoading(optionsEnabled, loadedKey, storageKey),
    isConnected: true,
    error: null,
    updateScratch,
    deleteScratch,
  };
};
