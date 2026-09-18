import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
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

/** Stable empty list so "no data yet" renders don't churn downstream memos. */
const EMPTY_SESSIONS: Session[] = [];

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

  const { data, isLoading } = useQuery<Session[]>({
    ...workspaceSessionsQuery(workspaceId, hostId),
    enabled: enabled && !!workspaceId,
  });
  const sessions = data ?? EMPTY_SESSIONS;

  // Auto-select the most recently used session for this workspace.
  //
  // The selection is keyed by workspace, and several instances of this hook run
  // at once for the same key: every pane has its own WorkspaceProvider and the
  // app shell has a document-level one whose workspaceId follows the URL — which
  // mirrors the *active* pane. So "this instance's workspaceId changed" says
  // nothing about the pane the user is looking at: switching panes and coming
  // back walks the document instance W -> other -> W, and treating that as a
  // workspace switch used to overwrite the new-session mode a pane was showing.
  // Per-workspace keys already keep one workspace's mode out of another's.
  //
  // So this only ever *seeds* a selection: whatever the user picked — the
  // new-session composer or an older session — stands until they pick something
  // else, and only a selection pointing at a session that no longer exists is
  // replaced. Explicit jumps (send, vibe review, command bar) call
  // selectSession/onSelectSession themselves.
  useEffect(() => {
    // Nothing known about this workspace's sessions yet (still loading, query
    // disabled, cache evicted). The chat shows the composer meanwhile, so the
    // user can pick "new session" before the list lands — treating "unknown" as
    // "no sessions" here would drop that choice the moment it arrives.
    if (data === undefined) return;
    if (data.length === 0) {
      setStoredSelection(selectionKey, undefined);
      return;
    }
    const currentSelection =
      useWorkspaceSessionSelectionStore.getState().selections[selectionKey];
    if (currentSelection?.mode === 'new') return;
    if (
      currentSelection?.mode === 'existing' &&
      data.some((session) => session.id === currentSelection.sessionId)
    ) {
      return;
    }
    // Sessions are ordered by most recently used, so first is the most recently used
    setStoredSelection(selectionKey, {
      mode: 'existing',
      sessionId: data[0].id,
    });
  }, [data, selectionKey, setStoredSelection]);

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
