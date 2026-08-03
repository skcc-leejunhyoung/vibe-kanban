import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { ErrorDialog } from '@vibe/ui/components/ErrorDialog';
import { sessionsApi, workspacesApi } from '@/shared/lib/api';
import { usePrFromAiBackgroundStore } from '@/shared/stores/usePrFromAiBackgroundStore';
import { runReviewAndCreatePr } from './reviewAndCreatePr';

vi.mock('@vibe/ui/components/ErrorDialog', () => ({
  ErrorDialog: { show: vi.fn() },
}));

vi.mock('@/shared/dialogs/command-bar/PullFirstDialog', () => ({
  PullFirstDialog: { show: vi.fn() },
}));

vi.mock('@/shared/lib/api', () => ({
  sessionsApi: {
    vibeReview: vi.fn(),
    getVibeReviewStatus: vi.fn(),
  },
  workspacesApi: {
    get: vi.fn(),
    getRepos: vi.fn(),
    getBranchStatus: vi.fn(),
    pushTargetBranch: vi.fn(),
  },
}));

vi.mock('@/shared/stores/usePrFromAiBackgroundStore', () => ({
  usePrFromAiBackgroundStore: {
    getState: vi.fn(),
  },
}));

const queryClient = {
  invalidateQueries: vi.fn(),
} as unknown as QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runReviewAndCreatePr', () => {
  it('shows a warning dialog when an intermediate step fails', async () => {
    vi.mocked(sessionsApi.vibeReview).mockRejectedValue(
      new Error('Review could not be started')
    );

    await expect(
      runReviewAndCreatePr({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        queryClient,
      })
    ).resolves.toBe(false);

    expect(ErrorDialog.show).toHaveBeenCalledWith({
      title: 'Review and create PR from ai failed',
      message: 'Review could not be started',
    });
  });

  it('does not duplicate the PR creation store error dialog', async () => {
    vi.mocked(sessionsApi.vibeReview).mockResolvedValue({
      id: 'review-session-1',
    } as never);
    vi.mocked(sessionsApi.getVibeReviewStatus).mockResolvedValue({
      phase: 'done',
    } as never);
    vi.mocked(workspacesApi.get).mockResolvedValue({
      branch: 'vk/work-branch',
    } as never);
    vi.mocked(workspacesApi.getRepos).mockResolvedValue([
      {
        id: 'repo-1',
        name: 'repo-1',
        target_branch: 'feature',
        default_target_branch: 'develop',
      },
    ] as never);
    vi.mocked(workspacesApi.getBranchStatus).mockResolvedValue([
      {
        repo_id: 'repo-1',
        is_target_remote: true,
        merges: [
          {
            type: 'direct',
            target_branch_name: 'feature',
          },
        ],
      },
    ] as never);
    const startCreateFromAi = vi.fn().mockResolvedValue(false);
    vi.mocked(usePrFromAiBackgroundStore.getState).mockReturnValue({
      startCreateFromAi,
    } as never);

    await expect(
      runReviewAndCreatePr({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        queryClient,
      })
    ).resolves.toBe(false);

    expect(startCreateFromAi).toHaveBeenCalledWith('workspace-1', 'repo-1', {
      headBranch: 'feature',
      targetBranch: 'develop',
      workBranch: 'vk/work-branch',
      hostId: undefined,
    });
    expect(ErrorDialog.show).not.toHaveBeenCalled();
  });
});
