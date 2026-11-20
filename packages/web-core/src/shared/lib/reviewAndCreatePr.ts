import type { QueryClient } from '@tanstack/react-query';
import { sessionsApi, workspacesApi } from '@/shared/lib/api';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { vibeRunStatusKeys } from '@/shared/hooks/useVibeRunStatus';
import { confirmUnpushedWorkBranchPush } from '@/shared/lib/unpushedWorkBranch';
import { choosePrBases, predictedPrHead } from '@/shared/lib/prBases';
import type { ExecutorConfig, Session } from 'shared/types';

export interface ReviewAndCreatePrOptions {
  workspaceId: string;
  sessionId: string;
  hostId?: string | null;
  executorConfig?: ExecutorConfig | null;
  queryClient: QueryClient;
  onReviewSession?: (sessionId: string) => void;
}

/**
 * The one decision the server cannot take for the user: publishing a work
 * branch that was never pushed. It is asked before the review starts, because
 * once it has started nothing waits for this page any more.
 */
async function confirmWorkBranchPushes(
  workspaceId: string,
  hostId: string | null | undefined
): Promise<boolean> {
  let loaded;
  try {
    loaded = await Promise.all([
      workspacesApi.get(workspaceId, hostId),
      workspacesApi.getRepos(workspaceId, hostId),
      workspacesApi.getBranchStatus(workspaceId, hostId),
    ]);
  } catch {
    // Not knowing the remote state never blocked a PR (see
    // confirmUnpushedWorkBranchPush); it does not block the review either.
    return true;
  }
  const [workspace, repos, branchStatuses] = loaded;
  for (const repo of repos) {
    const head = predictedPrHead(
      branchStatuses.find((status) => status.repo_id === repo.id),
      repo.target_branch
    );
    const proceed = await confirmUnpushedWorkBranchPush(
      workspaceId,
      repo.id,
      workspace.branch,
      head,
      hostId
    );
    if (!proceed) return false;
  }
  return true;
}

/**
 * "Review and create PR", behind both the composer split-button and the
 * command palette: start the review with the request to push the target
 * branch and open an AI draft PR once its merge lands.
 *
 * The server carries the workflow from there — closing, reloading or
 * suspending this page changes nothing — and the workspace shows the server's
 * progress (see useVibeRunStatus). Resolves `false` when the user declined to
 * publish a never-pushed work branch; rejects when the review could not start.
 */
export async function runReviewAndCreatePr({
  workspaceId,
  sessionId,
  hostId,
  executorConfig,
  queryClient,
  onReviewSession,
}: ReviewAndCreatePrOptions): Promise<boolean> {
  const bases = await choosePrBases(workspaceId, hostId);
  if (!bases) return false;
  if (!(await confirmWorkBranchPushes(workspaceId, hostId))) return false;

  const reviewSession = await sessionsApi.vibeReview(
    sessionId,
    hostId,
    executorConfig,
    true,
    bases
  );
  // Switch at once; the list refetch catches up in the background.
  queryClient.setQueryData<Session[]>(
    workspaceSessionKeys.byWorkspace(workspaceId, hostId),
    (current) => [
      reviewSession,
      ...(current ?? []).filter((s) => s.id !== reviewSession.id),
    ]
  );
  onReviewSession?.(reviewSession.id);
  void queryClient.invalidateQueries({
    queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
  });
  void queryClient.invalidateQueries({
    queryKey: vibeRunStatusKeys.workspace(workspaceId),
  });
  return true;
}

/**
 * Retry the blocked step with the repos' current default target branches, so a
 * base fixed in Settings takes effect; completed steps are not repeated.
 */
export async function retryReviewAndCreatePr(
  workspaceId: string,
  sessionId: string,
  hostId?: string | null
) {
  const run = await sessionsApi.getVibeReviewStatus(sessionId, hostId);
  if (!run.pr_requested) return sessionsApi.vibeRetryMerge(sessionId, hostId);
  const bases = await choosePrBases(workspaceId, hostId, {
    afterMerge: !!run.failed_phase,
  });
  return bases ? sessionsApi.vibeRetryMerge(sessionId, hostId, bases) : null;
}
