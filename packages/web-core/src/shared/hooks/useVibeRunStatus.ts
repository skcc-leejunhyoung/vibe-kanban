import { useQuery } from '@tanstack/react-query';
import { sessionsApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useAfterAgentTurnRefetch } from '@/shared/hooks/useAfterAgentTurnRefetch';

export const vibeRunStatusKeys = {
  /** Every host scope of the workspace's status (to invalidate). */
  workspace: (workspaceId: string | undefined) =>
    ['vibeRunStatus', workspaceId] as const,
  byWorkspace: (
    workspaceId: string | undefined,
    hostId: string | null = null
  ) =>
    [
      'vibeRunStatus',
      workspaceId,
      getHostRequestScopeQueryKey(hostId),
    ] as const,
};

/** Steps the server takes with no agent turn whose end would mark them. */
const SERVER_STEPS = new Set(['merging', 'pushing', 'creating_pr']);
const SERVER_STEP_POLL_MS = 3_000;
/** A review's verdict may land in a session other than the one on screen. */
const REVIEW_POLL_MS = 15_000;
/** Backup for a run started, retried or finished from somewhere else. */
const BACKUP_POLL_MS = 60_000;

function pollMs(phase: string | null | undefined): number {
  if (phase && SERVER_STEPS.has(phase)) return SERVER_STEP_POLL_MS;
  return phase === 'review' ? REVIEW_POLL_MS : BACKUP_POLL_MS;
}

/**
 * The server's state of the workspace's vibe run, for display only. The run
 * moves on the server whether or not this is mounted; nothing here drives it.
 * Read afresh on every mount (reopening a workspace shows where the run
 * stands now, not where it stood), after each turn of the session on screen,
 * and on a timer paced by how soon the phase can change.
 */
export function useVibeRunStatus(workspaceId?: string, sessionId?: string) {
  const hostId = useHostId();
  const enabled = !!workspaceId && !!sessionId;
  const query = useQuery({
    queryKey: vibeRunStatusKeys.byWorkspace(workspaceId, hostId),
    queryFn: () => sessionsApi.getVibeReviewStatus(sessionId!, hostId),
    enabled,
    staleTime: 0,
    refetchInterval: (query) => pollMs(query.state.data?.phase),
  });
  useAfterAgentTurnRefetch(enabled, query.refetch);
  return query;
}
