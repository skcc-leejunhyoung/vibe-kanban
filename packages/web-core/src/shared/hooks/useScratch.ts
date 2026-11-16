import { useCallback } from 'react';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useLocalStorageScratch } from '@/shared/hooks/useLocalStorageScratch';
import { scratchApi } from '@/shared/lib/api';
import { ScratchType, type Scratch, type UpdateScratch } from 'shared/types';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useHostId } from '@/shared/providers/HostIdProvider';

type ScratchState = {
  scratch: Scratch | null;
};

export interface UseScratchResult {
  scratch: Scratch | null;
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
  updateScratch: (update: UpdateScratch) => Promise<void>;
  deleteScratch: () => Promise<void>;
}

interface UseScratchOptions {
  /** Whether to enable the scratch connection. Defaults to true. */
  enabled?: boolean;
}

/**
 * Runtime-aware scratch storage hook.
 *
 * - Local runtime: streams a single scratch item via WebSocket (JSON Patch)
 *   backed by the server-side SQLite scratch table.
 * - Remote runtime: persists scratch data in localStorage for the stable
 *   cloud domain (cloud.vibekanban.com).
 */
export const useScratch = (
  scratchType: ScratchType,
  id: string,
  options?: UseScratchOptions
): UseScratchResult => {
  const runtime = useAppRuntime();
  const { userId } = useAuth();
  const isRemote = runtime === 'remote';
  // The stream below reads from this host (the pane's, or this machine's at
  // the app root). Writes must go to the same place: left to the transport's
  // ambient host they would follow the focused pane instead, saving one
  // host's scratch — app-wide UI preferences included — into another's.
  const hostId = useHostId();

  // --- localStorage path (remote-web) ---
  const localResult = useLocalStorageScratch(userId, scratchType, id, {
    enabled: isRemote && (options?.enabled ?? true),
  });

  // --- WebSocket/API path (local-web) ---
  const serverEnabled =
    !isRemote && (options?.enabled ?? true) && id.length > 0;
  const endpoint = serverEnabled
    ? scratchApi.getStreamUrl(scratchType, id)
    : undefined;

  const initialData = useCallback((): ScratchState => ({ scratch: null }), []);

  const { data, isConnected, isInitialized, error } =
    useJsonPatchWsStream<ScratchState>(endpoint, serverEnabled, initialData, {
      targetHostId: hostId,
    });

  // Treat deleted scratches as null
  const rawScratch = data?.scratch as (Scratch & { deleted?: boolean }) | null;
  const scratch = rawScratch?.deleted ? null : rawScratch;

  const updateScratch = useCallback(
    async (update: UpdateScratch) => {
      await scratchApi.update(scratchType, id, update, hostId);
    },
    [scratchType, id, hostId]
  );

  const deleteScratch = useCallback(async () => {
    await scratchApi.delete(scratchType, id, hostId);
  }, [scratchType, id, hostId]);

  const isLoading = !isInitialized && !error;

  const serverResult: UseScratchResult = {
    scratch,
    isLoading,
    isConnected,
    error,
    updateScratch,
    deleteScratch,
  };

  return isRemote ? localResult : serverResult;
};
