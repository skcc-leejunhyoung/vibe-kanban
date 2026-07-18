import { useEffect, useRef } from 'react';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import {
  useKanbanIssueComposerStore,
  type KanbanIssueComposerEntry,
} from '@/shared/stores/useKanbanIssueComposerStore';

const STORAGE_PREFIX = 'vk-kanban-issue-composer-user';
const LEGACY_STORAGE_KEY = 'vk-kanban-issue-composer';
const SCRATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredComposerState {
  updatedAt: string;
  byKey: Record<string, KanbanIssueComposerEntry | undefined>;
}

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}`;
}

export function readStoredComposerState(
  userId: string
): Record<string, KanbanIssueComposerEntry | undefined> | null {
  try {
    const key = storageKey(userId);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredComposerState;
    const updatedAt = Date.parse(parsed.updatedAt);
    if (
      !parsed.byKey ||
      typeof parsed.byKey !== 'object' ||
      !Number.isFinite(updatedAt) ||
      Date.now() - updatedAt > SCRATCH_TTL_MS
    ) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.byKey;
  } catch {
    return null;
  }
}

export function writeStoredComposerState(
  userId: string,
  byKey: Record<string, KanbanIssueComposerEntry | undefined>
): void {
  try {
    const filtered: Record<string, KanbanIssueComposerEntry> = {};
    for (const [key, entry] of Object.entries(byKey)) {
      if (entry) filtered[key] = entry;
    }

    if (Object.keys(filtered).length === 0) {
      localStorage.removeItem(storageKey(userId));
    } else {
      const stored: StoredComposerState = {
        updatedAt: new Date().toISOString(),
        byKey: filtered,
      };
      localStorage.setItem(storageKey(userId), JSON.stringify(stored));
    }
  } catch {
    // Quota exceeded or unavailable
  }
}

export function clearKanbanIssueComposerScratchForUser(userId: string): void {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // Storage unavailable
  }
}

export function clearLegacyKanbanIssueComposerScratch(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage unavailable
  }
}

/**
 * Syncs KanbanIssueComposerStore to localStorage on remote-web.
 * No-op on local runtime. Call once at the app root level.
 *
 * Hydration happens synchronously on first call (before any effects)
 * to avoid race conditions with React StrictMode double-mounting.
 */
export function useKanbanIssueComposerScratch() {
  const runtime = useAppRuntime();
  const { userId } = useAuth();
  const isRemote = runtime === 'remote';
  const isApplyingRef = useRef(false);
  const hydratedUserIdRef = useRef<string | null>(null);
  const prevByKeyRef = useRef(useKanbanIssueComposerStore.getState().byKey);

  // Hydrate synchronously during render (not in an effect) to ensure
  // the store has data before any child components mount.
  // This avoids StrictMode double-mount issues where effects run,
  // clean up, then run again — but refs persist across that cycle.
  if (isRemote && userId && hydratedUserIdRef.current !== userId) {
    clearLegacyKanbanIssueComposerScratch();
    const stored = readStoredComposerState(userId) ?? {};
    isApplyingRef.current = true;
    useKanbanIssueComposerStore.setState({ byKey: stored });
    isApplyingRef.current = false;
    prevByKeyRef.current = stored;
    hydratedUserIdRef.current = userId;
  }

  useEffect(() => {
    if (!isRemote || !userId) {
      if (isRemote && hydratedUserIdRef.current !== null) {
        const empty = {};
        isApplyingRef.current = true;
        useKanbanIssueComposerStore.setState({ byKey: empty });
        isApplyingRef.current = false;
        prevByKeyRef.current = empty;
        hydratedUserIdRef.current = null;
      }
      return;
    }

    const unsubscribe = useKanbanIssueComposerStore.subscribe((state) => {
      if (isApplyingRef.current) return;
      if (prevByKeyRef.current === state.byKey) return;
      prevByKeyRef.current = state.byKey;
      writeStoredComposerState(userId, state.byKey);
    });

    return unsubscribe;
  }, [isRemote, userId]);
}
