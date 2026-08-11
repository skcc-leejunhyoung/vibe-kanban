import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { ErrorDialog } from '@vibe/ui/components/ErrorDialog';
import { sessionsApi, workspacesApi } from '@/shared/lib/api';
import { usePrFromAiBackgroundStore } from '@/shared/stores/usePrFromAiBackgroundStore';
import { confirmUnpushedWorkBranchPush } from '@/shared/lib/unpushedWorkBranch';
import type { ExecutorConfig } from 'shared/types';
import {
  resumeReviewAndCreatePr,
  runReviewAndCreatePr,
} from './reviewAndCreatePr';

vi.mock('@vibe/ui/components/ErrorDialog', () => ({
  ErrorDialog: { show: vi.fn() },
}));

vi.mock('@/shared/dialogs/command-bar/PullFirstDialog', () => ({
  PullFirstDialog: { show: vi.fn() },
}));

vi.mock('@/shared/lib/unpushedWorkBranch', () => ({
  confirmUnpushedWorkBranchPush: vi.fn(),
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
const storage = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  clear: () => storage.clear(),
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(confirmUnpushedWorkBranchPush).mockResolvedValue(true);
});

describe('runReviewAndCreatePr', () => {
  it('passes the composer executor config to the review session', async () => {
    const executorConfig = {
      executor: 'CLAUDE_CODE',
      variant: 'default',
      model_id: 'claude-sonnet',
    } as ExecutorConfig;
    vi.mocked(sessionsApi.vibeReview).mockRejectedValue(
      new Error('Review could not be started')
    );

    await runReviewAndCreatePr({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      hostId: 'host-1',
      executorConfig,
      queryClient,
    });

    expect(sessionsApi.vibeReview).toHaveBeenCalledWith(
      'session-1',
      'host-1',
      executorConfig
    );
  });

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
    expect(confirmUnpushedWorkBranchPush).toHaveBeenCalledWith(
      'workspace-1',
      'repo-1',
      'vk/work-branch',
      'feature',
      undefined
    );
    expect(ErrorDialog.show).not.toHaveBeenCalled();
  });

  it('does not create an AI PR when the unpushed-work-branch warning is cancelled', async () => {
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
      { id: 'repo-1', name: 'repo-1', target_branch: 'develop' },
    ] as never);
    vi.mocked(workspacesApi.getBranchStatus).mockResolvedValue([
      { repo_id: 'repo-1', is_target_remote: true, merges: [] },
    ] as never);
    vi.mocked(confirmUnpushedWorkBranchPush).mockResolvedValue(false);
    const startCreateFromAi = vi.fn();
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

    expect(startCreateFromAi).not.toHaveBeenCalled();
  });

  it('resumes the push and PR steps without starting another review', async () => {
    localStorage.setItem(
      'vibe-review-and-create-pr',
      JSON.stringify({
        'local:workspace-1': {
          workspaceId: 'workspace-1',
          reviewSessionId: 'review-session-1',
          hostId: null,
        },
      })
    );
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
        is_target_remote: false,
        merges: [{ type: 'direct', target_branch_name: 'feature' }],
      },
    ] as never);
    vi.mocked(workspacesApi.pushTargetBranch).mockResolvedValue({
      success: true,
    } as never);
    const startCreateFromAi = vi.fn().mockResolvedValue(true);
    vi.mocked(usePrFromAiBackgroundStore.getState).mockReturnValue({
      startCreateFromAi,
    } as never);

    await expect(resumeReviewAndCreatePr('workspace-1', null)).resolves.toBe(
      true
    );

    expect(sessionsApi.vibeReview).not.toHaveBeenCalled();
    expect(workspacesApi.pushTargetBranch).toHaveBeenCalledOnce();
    expect(startCreateFromAi).toHaveBeenCalledOnce();
    expect(localStorage.getItem('vibe-review-and-create-pr')).toBe('{}');
  });
});
