import type { QueryClient } from '@tanstack/react-query';
import { ErrorDialog } from '@vibe/ui/components/ErrorDialog';
import { sessionsApi, workspacesApi } from '@/shared/lib/api';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { PullFirstDialog } from '@/shared/dialogs/command-bar/PullFirstDialog';
import { usePrFromAiBackgroundStore } from '@/shared/stores/usePrFromAiBackgroundStore';
import { confirmUnpushedWorkBranchPush } from '@/shared/lib/unpushedWorkBranch';
import type { ExecutorConfig } from 'shared/types';

const VIBE_REVIEW_POLL_MS = 2000;
const VIBE_REVIEW_TIMEOUT_MS = 60 * 60 * 1000;
const STORAGE_KEY = 'vibe-review-and-create-pr';

interface PendingReviewAndCreatePr {
  workspaceId: string;
  reviewSessionId: string;
  hostId: string | null;
}

const inFlight = new Map<string, Promise<boolean>>();

function workflowKey(workspaceId: string, hostId?: string | null): string {
  return `${hostId ?? 'local'}:${workspaceId}`;
}

function readPending(): Record<string, PendingReviewAndCreatePr> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function savePending(pending: PendingReviewAndCreatePr): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...readPending(),
        [workflowKey(pending.workspaceId, pending.hostId)]: pending,
      })
    );
  } catch {
    // Persistence is a recovery aid; storage restrictions must not block review.
  }
}

function clearPending(workspaceId: string, hostId?: string | null): void {
  try {
    const pending = readPending();
    delete pending[workflowKey(workspaceId, hostId)];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // Ignore unavailable storage after the workflow has already completed.
  }
}

async function waitForVibeReviewCompletion(
  sessionId: string,
  hostId?: string | null
): Promise<void> {
  const deadline = Date.now() + VIBE_REVIEW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { phase } = await sessionsApi.getVibeReviewStatus(sessionId, hostId);
    if (phase === 'done') return;
    if (phase === 'blocked') {
      throw new Error('The automated review was blocked before merge.');
    }
    await new Promise((resolve) =>
      window.setTimeout(resolve, VIBE_REVIEW_POLL_MS)
    );
  }
  throw new Error('Timed out waiting for the automated review to merge.');
}

export interface ReviewAndCreatePrOptions {
  workspaceId: string;
  sessionId: string;
  hostId?: string | null;
  executorConfig?: ExecutorConfig | null;
  queryClient: QueryClient;
  onReviewSession?: (sessionId: string) => void;
}

/**
 * Shared workflow behind both the composer split-button and command palette:
 * review -> merge -> push the materialized target -> create an AI draft PR.
 */
async function executeReviewAndCreatePr({
  workspaceId,
  sessionId,
  hostId,
  executorConfig,
  queryClient,
  onReviewSession,
}: ReviewAndCreatePrOptions): Promise<boolean> {
  const reviewSession = await sessionsApi.vibeReview(
    sessionId,
    hostId,
    executorConfig
  );
  savePending({
    workspaceId,
    reviewSessionId: reviewSession.id,
    hostId: hostId ?? null,
  });
  await queryClient.invalidateQueries({
    queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
  });
  onReviewSession?.(reviewSession.id);

  return continueReviewAndCreatePr(workspaceId, reviewSession.id, hostId);
}

async function continueReviewAndCreatePr(
  workspaceId: string,
  reviewSessionId: string,
  hostId: string | null | undefined
): Promise<boolean> {
  await waitForVibeReviewCompletion(reviewSessionId, hostId);
  const [workspace, repos, branchStatuses] = await Promise.all([
    workspacesApi.get(workspaceId, hostId),
    workspacesApi.getRepos(workspaceId, hostId),
    workspacesApi.getBranchStatus(workspaceId, hostId),
  ]);

  for (const repo of repos) {
    const repoStatus = branchStatuses.find(
      (status) => status.repo_id === repo.id
    );
    if (repoStatus && !repoStatus.is_target_remote) {
      const pushResult = await workspacesApi.pushTargetBranch(
        workspaceId,
        repo.id,
        false,
        hostId
      );
      if (!pushResult.success && pushResult.error?.type === 'diverged') {
        const resolution = await PullFirstDialog.show({
          workspaceId,
          repoId: repo.id,
          ahead: pushResult.error.ahead,
          behind: pushResult.error.behind,
          isTarget: true,
          hostId,
        });
        if (resolution !== 'success') {
          throw new Error(
            'The target branch must be reconciled before creating the pull request.'
          );
        }
      } else if (!pushResult.success) {
        throw new Error(
          pushResult.message ||
            `Failed to push target branch for ${repo.display_name || repo.name}.`
        );
      }
    }

    const directMerge = repoStatus?.merges?.find(
      (merge) => merge.type === 'direct'
    );
    const featureBranch =
      directMerge?.type === 'direct'
        ? directMerge.target_branch_name
        : undefined;
    const proceed = await confirmUnpushedWorkBranchPush(
      workspaceId,
      repo.id,
      workspace.branch,
      featureBranch ?? null,
      hostId
    );
    if (!proceed) return false;
    const created = await usePrFromAiBackgroundStore
      .getState()
      .startCreateFromAi(workspaceId, repo.id, {
        headBranch: featureBranch ?? null,
        targetBranch: featureBranch
          ? (repo.default_target_branch ?? repo.target_branch ?? null)
          : (repo.target_branch ?? null),
        workBranch: workspace.branch,
        hostId,
      });
    if (!created) {
      // The background PR store already surfaced the detailed failure.
      return false;
    }
  }

  return true;
}

export async function runReviewAndCreatePr(
  options: ReviewAndCreatePrOptions
): Promise<boolean> {
  const key = workflowKey(options.workspaceId, options.hostId);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = executeReviewAndCreatePr(options);
  inFlight.set(key, run);
  try {
    const completed = await run;
    clearPending(options.workspaceId, options.hostId);
    return completed;
  } catch (error) {
    void ErrorDialog.show({
      title: 'Review and create PR from ai failed',
      message:
        error instanceof Error
          ? error.message
          : 'The review and pull request workflow failed.',
    });
    return false;
  } finally {
    inFlight.delete(key);
  }
}

export async function resumeReviewAndCreatePr(
  workspaceId: string,
  hostId: string | null | undefined
): Promise<boolean> {
  const key = workflowKey(workspaceId, hostId);
  const pending = readPending()[key];
  if (!pending) return false;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = continueReviewAndCreatePr(
    workspaceId,
    pending.reviewSessionId,
    hostId
  );
  inFlight.set(key, run);
  try {
    const completed = await run;
    clearPending(workspaceId, hostId);
    return completed;
  } catch (error) {
    void ErrorDialog.show({
      title: 'Review and create PR from ai failed',
      message:
        error instanceof Error
          ? error.message
          : 'The review and pull request workflow failed.',
    });
    return false;
  } finally {
    inFlight.delete(key);
  }
}
