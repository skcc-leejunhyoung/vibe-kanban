import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { sessionsApi, workspacesApi } from '@/shared/lib/api';
import { confirmUnpushedWorkBranchPush } from '@/shared/lib/unpushedWorkBranch';
import type { ExecutorConfig, RepoBranchStatus } from 'shared/types';
import {
  runReviewAndCreatePr,
  retryReviewAndCreatePr,
} from './reviewAndCreatePr';

import { choosePrBases, predictedPrHead } from './prBases';
vi.mock('./prBases', async (original) => ({
  ...(await original<typeof import('./prBases')>()),
  choosePrBases: vi.fn(),
}));

vi.mock('@/shared/lib/unpushedWorkBranch', () => ({
  confirmUnpushedWorkBranchPush: vi.fn(),
}));

vi.mock('@/shared/lib/api', () => ({
  sessionsApi: {
    vibeReview: vi.fn(),
    getVibeReviewStatus: vi.fn(),
    vibeRetryMerge: vi.fn(),
  },
  workspacesApi: {
    get: vi.fn(),
    getRepos: vi.fn(),
    getBranchStatus: vi.fn(),
    pushTargetBranch: vi.fn(),
    generatePrDescription: vi.fn(),
    createPR: vi.fn(),
  },
}));

const queryClient = {
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
} as unknown as QueryClient;

const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
vi.stubGlobal('localStorage', storage);

function repoStatus(merges: unknown[]): RepoBranchStatus {
  return { repo_id: 'repo-1', merges } as unknown as RepoBranchStatus;
}

const directMerge = { type: 'direct', target_branch_name: 'feature' };
const openPr = (head: string | null) => ({
  type: 'pr',
  head_branch_name: head,
  pr_info: { number: 7, status: 'open' },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(choosePrBases).mockResolvedValue([
    { repo_id: 'repo-1', base_branch: 'integration' },
  ]);
  vi.mocked(confirmUnpushedWorkBranchPush).mockResolvedValue(true);
  vi.mocked(sessionsApi.vibeReview).mockResolvedValue({
    id: 'review-session-1',
  } as never);
  vi.mocked(workspacesApi.get).mockResolvedValue({
    branch: 'vk/work-branch',
  } as never);
  vi.mocked(workspacesApi.getRepos).mockResolvedValue([
    { id: 'repo-1', target_branch: 'feature' },
  ] as never);
  vi.mocked(workspacesApi.getBranchStatus).mockResolvedValue([
    repoStatus([]),
  ] as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runReviewAndCreatePr', () => {
  it('hands the whole workflow to the server and drives nothing itself', async () => {
    vi.useFakeTimers();
    const executorConfig = {
      executor: 'CLAUDE_CODE',
      variant: 'default',
      model_id: 'claude-sonnet',
    } as ExecutorConfig;
    const onReviewSession = vi.fn();

    await expect(
      runReviewAndCreatePr({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        hostId: 'host-1',
        executorConfig,
        queryClient,
        onReviewSession,
      })
    ).resolves.toBe(true);

    // The request carries the intent; the server pushes and opens the PR.
    expect(sessionsApi.vibeReview).toHaveBeenCalledWith(
      'session-1',
      'host-1',
      executorConfig,
      true,
      [{ repo_id: 'repo-1', base_branch: 'integration' }]
    );
    expect(onReviewSession).toHaveBeenCalledWith('review-session-1');
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['vibeRunStatus', 'workspace-1'],
    });

    // The page that started it may now sit suspended or be closed: an hour
    // later it has polled nothing, pushed nothing, created nothing and left
    // no resume record behind.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sessionsApi.getVibeReviewStatus).not.toHaveBeenCalled();
    expect(workspacesApi.pushTargetBranch).not.toHaveBeenCalled();
    expect(workspacesApi.generatePrDescription).not.toHaveBeenCalled();
    expect(workspacesApi.createPR).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks about publishing a never-pushed work branch before the review starts', async () => {
    // The repo already has an open PR for another head, so the merge skips it
    // and the new PR would come from the work branch.
    vi.mocked(workspacesApi.getBranchStatus).mockResolvedValue([
      repoStatus([openPr('other-branch')]),
    ] as never);
    vi.mocked(confirmUnpushedWorkBranchPush).mockResolvedValue(false);

    await expect(
      runReviewAndCreatePr({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        hostId: 'host-1',
        queryClient,
      })
    ).resolves.toBe(false);

    expect(confirmUnpushedWorkBranchPush).toHaveBeenCalledWith(
      'workspace-1',
      'repo-1',
      'vk/work-branch',
      null,
      'host-1'
    );
    // Declined: no review, so nothing the server would later push.
    expect(sessionsApi.vibeReview).not.toHaveBeenCalled();
  });

  it('does not question the usual case, where the PR comes from the merged-into branch', async () => {
    await runReviewAndCreatePr({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      queryClient,
    });

    expect(confirmUnpushedWorkBranchPush).toHaveBeenCalledWith(
      'workspace-1',
      'repo-1',
      'vk/work-branch',
      'feature',
      undefined
    );
    const asked = vi.mocked(confirmUnpushedWorkBranchPush).mock
      .invocationCallOrder[0];
    const started = vi.mocked(sessionsApi.vibeReview).mock
      .invocationCallOrder[0];
    expect(asked).toBeLessThan(started);
  });

  it('refuses to start when PR destinations cannot be confirmed', async () => {
    vi.mocked(choosePrBases).mockRejectedValue(new Error('host unreachable'));
    await expect(
      runReviewAndCreatePr({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        queryClient,
      })
    ).rejects.toThrow('host unreachable');
    expect(confirmUnpushedWorkBranchPush).not.toHaveBeenCalled();
    expect(sessionsApi.vibeReview).not.toHaveBeenCalled();
  });

  it('does not start anything when the base selection is cancelled', async () => {
    vi.mocked(choosePrBases).mockResolvedValue(null);
    expect(
      await runReviewAndCreatePr({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        queryClient,
      })
    ).toBe(false);
    expect(confirmUnpushedWorkBranchPush).not.toHaveBeenCalled();
    expect(sessionsApi.vibeReview).not.toHaveBeenCalled();
  });

  it('rejects when the review cannot start, for the caller to report', async () => {
    vi.mocked(sessionsApi.vibeReview).mockRejectedValue(
      new Error('Review could not be started')
    );

    await expect(
      runReviewAndCreatePr({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        queryClient,
      })
    ).rejects.toThrow('Review could not be started');
    expect(queryClient.setQueryData).not.toHaveBeenCalled();
  });
});

describe('predictedPrHead', () => {
  it('is the target branch the review will merge into', () => {
    expect(predictedPrHead(repoStatus([]), 'feature')).toBe('feature');
    expect(predictedPrHead(undefined, 'feature')).toBe('feature');
  });

  it('is the branch an earlier merge went into', () => {
    expect(predictedPrHead(repoStatus([directMerge]), 'renamed')).toBe(
      'feature'
    );
    expect(
      predictedPrHead(repoStatus([openPr('feature'), directMerge]), 'renamed')
    ).toBe('feature');
  });

  it('is the work branch when an open PR makes the merge skip the repo', () => {
    expect(predictedPrHead(repoStatus([openPr(null)]), 'feature')).toBeNull();
  });

  it('ignores a PR that is closed or merged', () => {
    const merged = { ...openPr('feature'), pr_info: { status: 'merged' } };
    expect(predictedPrHead(repoStatus([merged]), 'feature')).toBe('feature');
  });
});

describe('retryReviewAndCreatePr', () => {
  it('reconfirms a blocked PR and resumes only the server step', async () => {
    const saved = [
      {
        repo_id: 'repo-1',
        base_branch: 'integration',
        target_branch: 'feature',
      },
    ];
    vi.mocked(sessionsApi.getVibeReviewStatus).mockResolvedValue({
      pr_requested: true,
      failed_phase: 'creating_pr',
      pr_bases: saved,
    } as never);
    await retryReviewAndCreatePr('workspace-1', 'session-1', 'host-1');
    expect(choosePrBases).toHaveBeenCalledWith('workspace-1', 'host-1', {
      afterMerge: true,
      saved,
    });
    expect(sessionsApi.vibeRetryMerge).toHaveBeenCalledWith(
      'session-1',
      'host-1',
      [{ repo_id: 'repo-1', base_branch: 'integration' }]
    );
    expect(sessionsApi.vibeReview).not.toHaveBeenCalled();
    expect(workspacesApi.pushTargetBranch).not.toHaveBeenCalled();
  });
  it('leaves a blocked run untouched when base selection is cancelled', async () => {
    vi.mocked(sessionsApi.getVibeReviewStatus).mockResolvedValue({
      pr_requested: true,
      failed_phase: 'creating_pr',
    } as never);
    vi.mocked(choosePrBases).mockResolvedValue(null);
    expect(await retryReviewAndCreatePr('workspace-1', 'session-1')).toBeNull();
    expect(sessionsApi.vibeRetryMerge).not.toHaveBeenCalled();
  });
});
