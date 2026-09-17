import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceCommit } from 'shared/types';
import { workspacesApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';
import {
  branchTipSignature,
  WORKSPACE_GIT_BACKUP_POLL_MS,
} from '@/shared/lib/workspaceGitRefetch';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';

export const workspaceCommitsKey = (
  workspaceId: string | null | undefined,
  hostId: string | null
) =>
  [
    'workspace-commits',
    getHostRequestScopeQueryKey(hostId),
    workspaceId,
  ] as const;

/**
 * Fetches the commits a workspace branch added on top of its base branch,
 * newest first, across all of the workspace's repos.
 */
export function useWorkspaceCommits(
  workspaceId: string | null | undefined,
  enabled = true
) {
  const hostId = useHostId();

  const query = useQuery<WorkspaceCommit[]>({
    queryKey: workspaceCommitsKey(workspaceId, hostId),
    queryFn: () => workspacesApi.getCommits(workspaceId!, hostId),
    enabled: enabled && !!workspaceId,
    // Commits change as the agent works; keep it reasonably fresh but avoid
    // hammering on every focus.
    staleTime: 10_000,
    // Backup only; the branch tip below is what normally triggers a re-read.
    refetchInterval:
      enabled && workspaceId ? WORKSPACE_GIT_BACKUP_POLL_MS : false,
  });

  // This list is a function of the branch tip, so re-read it whenever branch
  // status reports the tip (or the ahead-of-base count) moved. Branch status is
  // refreshed by every git action and by useAfterAgentTurnRefetch, so this one
  // trigger covers commit / merge / rebase / pull / change-target from both the
  // mutation hooks and the `Actions.*` paths the Git panel buttons dispatch.
  const { data: branchStatus } = useBranchStatus(workspaceId ?? undefined);
  const signature = branchTipSignature(branchStatus);
  const refetch = query.refetch;
  const lastTipRef = useRef({ workspaceId, signature });
  useEffect(() => {
    const previous = lastTipRef.current;
    lastTipRef.current = { workspaceId, signature };
    // A workspace switch already refetches through the new query key. An empty
    // signature is "branch status hasn't loaded yet" — on the previous side it
    // means this is the first load, which is the mount baseline and not a moved
    // tip (the commit query just fetched under its own key).
    if (previous.workspaceId !== workspaceId) return;
    if (!signature || !previous.signature) return;
    if (previous.signature === signature) return;
    if (!enabled || !workspaceId) return;
    // Not the default `cancelRefetch: true`: several observers share this query
    // and would otherwise each abort and restart the others' fetch.
    void refetch({ cancelRefetch: false });
  }, [signature, workspaceId, enabled, refetch]);

  return query;
}
