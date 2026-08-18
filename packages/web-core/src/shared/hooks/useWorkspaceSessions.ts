import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { sessionsApi } from '@/shared/lib/api';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import type { Session } from 'shared/types';

interface UseWorkspaceSessionsOptions {
  enabled?: boolean;
}

/**
 * Key + fetcher for a workspace's session list. Shared by the hook below and
 * intent prefetching (sidebar hover), so the two can never drift apart.
 * Callers must gate fetching on a defined `workspaceId` (`enabled`/prefetch
 * with a real id).
 */
export function workspaceSessionsQuery(
  workspaceId: string | undefined,
  hostId: string | null
) {
  return {
    queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
    queryFn: () => sessionsApi.getByWorkspace(workspaceId!, hostId),
  };
}

/** Discriminated union for session selection state */
export type SessionSelection =
  | { mode: 'existing'; sessionId: string }
  | { mode: 'new' };

interface WorkspaceSessionSelectionState {
  selections: Record<string, SessionSelection | undefined>;
  setSelection: (key: string, selection: SessionSelection | undefined) => void;
}

export const useWorkspaceSessionSelectionStore =
  create<WorkspaceSessionSelectionState>((set) => ({
    selections: {},
    setSelection: (key, selection) =>
      set((state) => ({
        selections: { ...state.selections, [key]: selection },
      })),
  }));

function workspaceSessionSelectionKey(
  workspaceId: string | undefined,
  hostId: string | null
) {
  return `${hostId ?? ''}:${workspaceId ?? ''}`;
}

export function selectWorkspaceSession(
  workspaceId: string,
  hostId: string | null,
  sessionId: string
) {
  const { setSelection } = useWorkspaceSessionSelectionStore.getState();
  setSelection(workspaceSessionSelectionKey(workspaceId, hostId), {
    mode: 'existing',
    sessionId,
  });
}

interface UseWorkspaceSessionsResult {
  sessions: Session[];
  selectedSession: Session | undefined;
  selectedSessionId: string | undefined;
  selectSession: (sessionId: string) => void;
  selectLatestSession: () => void;
  isLoading: boolean;
  /** Whether user is creating a new session */
  isNewSessionMode: boolean;
  /** Enter new session mode */
  startNewSession: () => void;
}

/**
 * Hook for managing sessions within a workspace.
 * Fetches all sessions for a workspace and provides session switching capability.
 * Sessions are ordered by most recently used (latest non-dev server execution first).
 */
export function useWorkspaceSessions(
  workspaceId: string | undefined,
  options: UseWorkspaceSessionsOptions = {}
): UseWorkspaceSessionsResult {
  const hostId = useHostId();
  const { enabled = true } = options;
  const selectionKey = workspaceSessionSelectionKey(workspaceId, hostId);
  const selection = useWorkspaceSessionSelectionStore(
    (state) => state.selections[selectionKey]
  );
  const setStoredSelection = useWorkspaceSessionSelectionStore(
    (state) => state.setSelection
  );
  const prevWorkspaceIdRef = useRef(workspaceId);

  const { data: sessions = [], isLoading } = useQuery<Session[]>({
    ...workspaceSessionsQuery(workspaceId, hostId),
    enabled: enabled && !!workspaceId,
  });

  // Combined effect: handle workspace changes and auto-select sessions
  // This replaces two separate effects that had a race condition where the reset
  // effect would fire after auto-select when sessions were cached, undoing the selection.
  useEffect(() => {
    const workspaceChanged = prevWorkspaceIdRef.current !== workspaceId;
    prevWorkspaceIdRef.current = workspaceId;

    if (sessions.length > 0) {
      // Sessions are ordered by most recently used, so first is the most recently used
      // Always select first session when sessions are available for this workspace
      // Only preserve new session mode within the same workspace
      const currentSelection =
        useWorkspaceSessionSelectionStore.getState().selections[selectionKey];
      if (currentSelection?.mode !== 'new' || workspaceChanged) {
        setStoredSelection(selectionKey, {
          mode: 'existing',
          sessionId: sessions[0].id,
        });
      }
    } else {
      setStoredSelection(selectionKey, undefined);
    }
  }, [workspaceId, sessions, selectionKey, setStoredSelection]);

  const isNewSessionMode = selection?.mode === 'new' || sessions.length === 0;
  const selectedSessionId =
    selection?.mode === 'existing' ? selection.sessionId : undefined;

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId),
    [sessions, selectedSessionId]
  );

  const selectSession = useCallback(
    (sessionId: string) =>
      setStoredSelection(selectionKey, { mode: 'existing', sessionId }),
    [selectionKey, setStoredSelection]
  );

  const selectLatestSession = useCallback(() => {
    if (sessions.length > 0) {
      setStoredSelection(selectionKey, {
        mode: 'existing',
        sessionId: sessions[0].id,
      });
    }
  }, [sessions, selectionKey, setStoredSelection]);

  const startNewSession = useCallback(() => {
    setStoredSelection(selectionKey, { mode: 'new' });
  }, [selectionKey, setStoredSelection]);

  return {
    sessions,
    selectedSession,
    selectedSessionId,
    selectSession,
    selectLatestSession,
    isLoading,
    isNewSessionMode,
    startNewSession,
  };
}
