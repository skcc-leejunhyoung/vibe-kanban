import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useAfterAgentTurnRefetch } from '@/shared/hooks/useAfterAgentTurnRefetch';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import type { VibeReviewStatus } from 'shared/types';

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

/** How soon to read the run again, by how soon it can move. */
export function vibeRunPollMs(
  status:
    | Pick<VibeReviewStatus, 'phase' | 'last_error' | 'pending_kind'>
    | undefined
): number {
  const phase = status?.phase;
  // Waiting for the automation worker's next step: seconds while it runs,
  // as long as it is down otherwise.
  if (status?.pending_kind) return REVIEW_POLL_MS;
  // A merge held up by a failure waits minutes to hours: for its next
  // scheduled try, or for the review session to sort the failure out.
  if (phase === 'merging' && status?.last_error) return REVIEW_POLL_MS;
  if (phase && SERVER_STEPS.has(phase)) return SERVER_STEP_POLL_MS;
  return phase === 'review' ? REVIEW_POLL_MS : BACKUP_POLL_MS;
}

/** One read of a run: whose it is and its phase (`undefined`: not read yet). */
interface SeenRun {
  workspaceId: string | undefined;
  phase: string | null | undefined;
}

/**
 * True when the same workspace's run is in another phase than at the previous
 * read. The first read is not a move, and neither is showing another workspace.
 */
export function vibeRunMoved(previous: SeenRun, next: SeenRun): boolean {
  return (
    !!next.workspaceId &&
    previous.workspaceId === next.workspaceId &&
    previous.phase !== undefined &&
    next.phase !== undefined &&
    previous.phase !== next.phase
  );
}

/**
 * The server's state of the workspace's vibe run, for display only. The run
 * moves on the server whether or not this is mounted; nothing here drives it.
 * Read afresh on every mount (reopening a workspace shows where the run
 * stands now, not where it stood), after each turn of the session on screen,
 * and on a timer paced by how soon the phase can change.
 *
 * The run is the workspace's; `sessionId` is only the session it is read
 * through, and has to be one that stays (see `isPrDraftSession`).
 */
export function useVibeRunStatus(workspaceId?: string, sessionId?: string) {
  const hostId = useHostId();
  const queryClient = useQueryClient();
  const enabled = !!workspaceId && !!sessionId;
  const query = useQuery({
    queryKey: vibeRunStatusKeys.byWorkspace(workspaceId, hostId),
    queryFn: () => sessionsApi.getVibeReviewStatus(sessionId!, hostId),
    enabled,
    staleTime: 0,
    refetchInterval: (query) => vibeRunPollMs(query.state.data),
  });
  useAfterAgentTurnRefetch(enabled, query.refetch);

  // The server's merge, push and PR change what the git views show (merged
  // state, pushed target, the PR link) with no turn of this session to mark
  // it: re-read them when the run moves, as the browser-driven flow did after
  // its own push and PR.
  const phase = query.data ? query.data.phase : undefined;
  const seen = useRef<SeenRun>({ workspaceId, phase });
  useEffect(() => {
    const previous = seen.current;
    const next = { workspaceId, phase };
    seen.current = next;
    if (!vibeRunMoved(previous, next)) return;
    void queryClient.invalidateQueries({
      queryKey: ['branchStatus', workspaceId],
    });
    void queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
  }, [workspaceId, phase, queryClient]);

  return query;
}
