import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspacesApi } from '@/shared/lib/api';
import { BranchPickerDialog } from '@/shared/dialogs/BranchPickerDialog';
import { choosePrBases } from './prBases';

vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/shared/lib/api', () => ({
  workspacesApi: {
    get: vi.fn(),
    getRepos: vi.fn(),
    getBranchStatus: vi.fn(),
    getPrBranchPlan: vi.fn(),
  },
}));
vi.mock('@/shared/dialogs/BranchPickerDialog', () => ({
  BranchPickerDialog: { show: vi.fn() },
}));
const repo = {
  id: 'example-repo',
  display_name: 'Example',
  target_branch: 'feature/example',
  default_target_branch: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(workspacesApi.get).mockResolvedValue({
    branch: 'vk/work',
  } as never);
  vi.mocked(workspacesApi.getRepos).mockResolvedValue([repo] as never);
  vi.mocked(workspacesApi.getBranchStatus).mockResolvedValue([]);
  vi.mocked(BranchPickerDialog.show).mockResolvedValue('integration');
  vi.mocked(workspacesApi.getPrBranchPlan).mockImplementation(
    async (_id, request) => {
      const head = request.after_merge ? 'vk/work' : 'feature/example';
      if (
        request.base_branch === head ||
        request.base_branch === `origin/${head}`
      )
        throw new Error('PR head and base must be different');
      return {
        head_branch: head,
        base_branch:
          request.base_branch ??
          (request.after_merge ? 'feature/example' : null),
      };
    }
  );
});

describe('choosePrBases', () => {
  it('shows the final head and missing base before review and accepts an execution-only choice', async () => {
    expect(await choosePrBases('example-workspace', 'example-host')).toEqual([
      { repo_id: repo.id, base_branch: 'integration' },
    ]);
    expect(BranchPickerDialog.show).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: 'example-host',
        headBranch: 'feature/example',
        initialBranch: null,
        mode: 'prBase',
      })
    );
    expect(repo.default_target_branch).toBeNull();
  });

  it('retains work-to-target for standalone PRs before a direct merge', async () => {
    await choosePrBases('example-workspace', null, { afterMerge: true });
    expect(BranchPickerDialog.show).toHaveBeenCalledWith(
      expect.objectContaining({
        headBranch: 'vk/work',
        initialBranch: 'feature/example',
      })
    );
  });

  it('uses actual merge results for the head and a saved base for retry despite a new default', async () => {
    vi.mocked(workspacesApi.getRepos).mockResolvedValue([
      {
        ...repo,
        target_branch: 'other',
        default_target_branch: 'another-default',
      },
    ] as never);
    vi.mocked(workspacesApi.getBranchStatus).mockResolvedValue([
      {
        repo_id: repo.id,
        merges: [{ type: 'direct', target_branch_name: 'feature/example' }],
      },
    ] as never);
    vi.mocked(workspacesApi.getPrBranchPlan).mockResolvedValue({
      head_branch: 'feature/example',
      base_branch: 'another-default',
    });
    await choosePrBases('example-workspace', null, {
      afterMerge: true,
      saved: [
        {
          repo_id: repo.id,
          base_branch: 'integration',
          target_branch: 'feature/example',
        },
      ],
    });
    expect(BranchPickerDialog.show).toHaveBeenCalledWith(
      expect.objectContaining({
        headBranch: 'feature/example',
        initialBranch: 'integration',
      })
    );
  });

  it('rejects identical branches before a caller can start review or draft text', async () => {
    vi.mocked(BranchPickerDialog.show).mockResolvedValue('feature/example');
    await expect(choosePrBases('example-workspace')).rejects.toThrow(
      'head and base'
    );
  });

  it('cancels the whole request when one of several repositories has no confirmed choice', async () => {
    vi.mocked(workspacesApi.getRepos).mockResolvedValue([
      repo,
      { ...repo, id: 'second-example-repo' },
    ] as never);
    vi.mocked(BranchPickerDialog.show)
      .mockResolvedValueOnce('integration')
      .mockResolvedValueOnce(null);
    expect(await choosePrBases('example-workspace')).toBeNull();
    expect(BranchPickerDialog.show).toHaveBeenCalledTimes(2);
  });

  it('fails closed if the branch state cannot be read', async () => {
    vi.mocked(workspacesApi.getPrBranchPlan).mockRejectedValue(
      new Error('host unavailable')
    );
    await expect(choosePrBases('example-workspace')).rejects.toThrow(
      'host unavailable'
    );
    expect(BranchPickerDialog.show).not.toHaveBeenCalled();
  });
  it('rejects a remote alias before any caller starts AI or review', async () => {
    vi.mocked(BranchPickerDialog.show).mockResolvedValue(
      'origin/feature/example'
    );
    await expect(choosePrBases('example-workspace')).rejects.toThrow(
      'head and base'
    );
    expect(workspacesApi.getPrBranchPlan).toHaveBeenLastCalledWith(
      'example-workspace',
      {
        repo_id: repo.id,
        after_merge: false,
        base_branch: 'origin/feature/example',
      },
      undefined
    );
  });

  it('requires a fresh selection if the head changes while the picker is open', async () => {
    vi.mocked(workspacesApi.getPrBranchPlan)
      .mockResolvedValueOnce({
        head_branch: 'feature/example',
        base_branch: null,
      })
      .mockResolvedValueOnce({
        head_branch: 'other',
        base_branch: 'integration',
      });
    await expect(choosePrBases('example-workspace')).rejects.toThrow(
      'tasks:prBase.headChanged'
    );
  });
});
