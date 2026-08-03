import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub the API layer so no network call can fire; the store is the unit here.
vi.mock('@/shared/lib/api', () => ({
  workspacesApi: {
    getBranchStatus: vi.fn(),
    generatePrDescription: vi.fn(),
    createPR: vi.fn(),
  },
}));

vi.mock('@/shared/lib/queryClient', () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock('@vibe/ui/lib/open-url', () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock('@vibe/ui/components/ConfirmDialog', () => ({
  ConfirmDialog: { show: vi.fn() },
}));

vi.mock('@/shared/dialogs/command-bar/PushErrorDialog', () => ({
  PushErrorDialog: { show: vi.fn() },
}));

vi.mock('@/i18n/config', () => ({
  default: { t: (key: string) => key },
}));

import { usePrFromAiBackgroundStore } from './usePrFromAiBackgroundStore';
import { workspacesApi } from '@/shared/lib/api';
import { queryClient } from '@/shared/lib/queryClient';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { PushErrorDialog } from '@/shared/dialogs/command-bar/PushErrorDialog';

const generatePrDescription = vi.mocked(workspacesApi.generatePrDescription);
const createPR = vi.mocked(workspacesApi.createPR);
const getBranchStatus = vi.mocked(workspacesApi.getBranchStatus);
const invalidateQueries = vi.mocked(queryClient.invalidateQueries);
const openPrUrl = vi.mocked(openExternalUrl);
const confirmShow = vi.mocked(ConfirmDialog.show);
const errorDialogShow = vi.mocked(PushErrorDialog.show);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Fake timers only replace setTimeout/clearTimeout, not Promise microtasks, so
// draining the async chain under them means ticking the microtask queue
// directly rather than relying on a setTimeout-based flush.
const flushMicrotasks = async (times = 5) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

const opts = {
  targetBranch: 'main',
  headBranch: null,
  workBranch: 'vk/work-branch',
};

describe('usePrFromAiBackgroundStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePrFromAiBackgroundStore.setState({ byWorkspace: {} });
    confirmShow.mockResolvedValue('canceled');
    getBranchStatus.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('progresses through generating -> creating -> success', async () => {
    generatePrDescription.mockResolvedValue({ title: 'T', description: 'D' });
    createPR.mockResolvedValue({ success: true, data: 'https://pr' });

    usePrFromAiBackgroundStore
      .getState()
      .startCreateFromAi('ws1', 'repo1', opts);
    expect(usePrFromAiBackgroundStore.getState().byWorkspace.ws1?.repo1).toBe(
      'generating'
    );

    await flush();
    await flush();

    expect(usePrFromAiBackgroundStore.getState().byWorkspace.ws1?.repo1).toBe(
      'success'
    );
    expect(createPR).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ title: 'T', body: 'D', draft: true }),
      undefined,
      undefined
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['branchStatus', 'ws1'],
    });
  });

  it('opens the PR url when the completion popup is confirmed', async () => {
    generatePrDescription.mockResolvedValue({ title: 'T', description: 'D' });
    createPR.mockResolvedValue({ success: true, data: 'https://pr' });
    confirmShow.mockResolvedValue('confirmed');

    usePrFromAiBackgroundStore
      .getState()
      .startCreateFromAi('ws-open', 'repo1', opts);
    await flush();
    await flush();

    expect(openPrUrl).toHaveBeenCalledWith('https://pr');
  });

  it('does not start a second run while one is in flight', async () => {
    generatePrDescription.mockReturnValue(new Promise(() => {}));

    const store = usePrFromAiBackgroundStore.getState();
    store.startCreateFromAi('ws-dup', 'repo1', opts);
    store.startCreateFromAi('ws-dup', 'repo1', opts);

    await flush();

    expect(generatePrDescription).toHaveBeenCalledTimes(1);
  });

  it('does not ask the agent when the repo already has an open PR', async () => {
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            pr_info: { number: 42, status: 'open' },
          },
        ],
      },
    ] as never);

    const result = await usePrFromAiBackgroundStore
      .getState()
      .startCreateFromAi('ws-existing-pr', 'repo1', opts);

    expect(result).toBe(false);
    expect(generatePrDescription).not.toHaveBeenCalled();
    expect(createPR).not.toHaveBeenCalled();
    expect(errorDialogShow).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'tasks:git.prFromAi.prAlreadyExists',
      })
    );
  });

  it('allows a PR when the repo only has an open PR from another feature branch', async () => {
    getBranchStatus.mockResolvedValue([
      {
        repo_id: 'repo1',
        merges: [
          {
            type: 'pr',
            head_branch_name: 'feature-a',
            pr_info: { number: 42, status: 'open' },
          },
        ],
      },
    ] as never);
    generatePrDescription.mockResolvedValue({ title: 'T', description: 'D' });
    createPR.mockResolvedValue({ success: true, data: 'https://pr' });

    const result = await usePrFromAiBackgroundStore
      .getState()
      .startCreateFromAi('ws-other-pr', 'repo1', {
        ...opts,
        headBranch: 'feature-b',
      });

    expect(result).toBe(true);
    expect(generatePrDescription).toHaveBeenCalledOnce();
    expect(createPR).toHaveBeenCalledOnce();
    expect(errorDialogShow).not.toHaveBeenCalled();
  });

  it('does not ask the agent when the work branch has no commits to propose', async () => {
    getBranchStatus.mockResolvedValue([
      { repo_id: 'repo1', commits_ahead: 0, merges: [] },
    ] as never);

    const result = await usePrFromAiBackgroundStore
      .getState()
      .startCreateFromAi('ws-no-commits', 'repo1', opts);

    expect(result).toBe(false);
    expect(generatePrDescription).not.toHaveBeenCalled();
    expect(createPR).not.toHaveBeenCalled();
    expect(errorDialogShow).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'tasks:git.prFromAi.noCommits' })
    );
  });

  it('surfaces a generation failure as an error state with a dialog', async () => {
    generatePrDescription.mockRejectedValue(new Error('agent failed'));

    usePrFromAiBackgroundStore
      .getState()
      .startCreateFromAi('ws-gen-err', 'repo1', opts);
    await flush();

    expect(
      usePrFromAiBackgroundStore.getState().byWorkspace['ws-gen-err']?.repo1
    ).toBe('error');
    expect(errorDialogShow).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'agent failed' })
    );
    expect(createPR).not.toHaveBeenCalled();
  });

  it('surfaces a rejected PR creation as an error state with a dialog', async () => {
    generatePrDescription.mockResolvedValue({ title: 'T', description: 'D' });
    createPR.mockResolvedValue({ success: false, message: 'no gh auth' });

    usePrFromAiBackgroundStore
      .getState()
      .startCreateFromAi('ws-create-err', 'repo1', opts);
    await flush();
    await flush();

    expect(
      usePrFromAiBackgroundStore.getState().byWorkspace['ws-create-err']?.repo1
    ).toBe('error');
    expect(errorDialogShow).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'no gh auth' })
    );
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('falls back to a generated title when the agent returns a blank one', async () => {
    generatePrDescription.mockResolvedValue({ title: '   ', description: 'D' });
    createPR.mockResolvedValue({ success: true, data: 'https://pr' });

    usePrFromAiBackgroundStore
      .getState()
      .startCreateFromAi('ws-fallback', 'repo1', opts);
    await flush();
    await flush();

    expect(createPR).toHaveBeenCalledWith(
      'ws-fallback',
      expect.objectContaining({ title: 'tasks:git.prFromAi.fallbackTitle' }),
      undefined,
      undefined
    );
  });

  it('routes generation and creation through the owning host', async () => {
    generatePrDescription.mockResolvedValue({ title: 'T', description: 'D' });
    createPR.mockResolvedValue({ success: true, data: 'https://pr' });

    await usePrFromAiBackgroundStore
      .getState()
      .startCreateFromAi('ws-remote', 'repo1', {
        ...opts,
        hostId: 'remote-host',
      });

    expect(getBranchStatus).toHaveBeenCalledWith('ws-remote', 'remote-host');
    expect(generatePrDescription).toHaveBeenCalledWith(
      'ws-remote',
      expect.objectContaining({ repo_id: 'repo1' }),
      undefined,
      'remote-host'
    );
    expect(createPR).toHaveBeenCalledWith(
      'ws-remote',
      expect.objectContaining({ repo_id: 'repo1' }),
      undefined,
      'remote-host'
    );
  });

  it('auto-clears the success status after the delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    generatePrDescription.mockResolvedValue({ title: 'T', description: 'D' });
    createPR.mockResolvedValue({ success: true, data: 'https://pr' });

    usePrFromAiBackgroundStore
      .getState()
      .startCreateFromAi('ws-clear', 'repo1', opts);

    await flushMicrotasks();

    expect(
      usePrFromAiBackgroundStore.getState().byWorkspace['ws-clear']?.repo1
    ).toBe('success');

    await vi.advanceTimersByTimeAsync(4000);

    expect(
      usePrFromAiBackgroundStore.getState().byWorkspace['ws-clear']
    ).toBeUndefined();
  });

  it('keeps status keyed independently per repo within the same workspace', () => {
    generatePrDescription.mockReturnValue(new Promise(() => {}));

    const store = usePrFromAiBackgroundStore.getState();
    store.startCreateFromAi('ws-multi', 'repo-a', opts);
    store.startCreateFromAi('ws-multi', 'repo-b', opts);

    expect(
      usePrFromAiBackgroundStore.getState().byWorkspace['ws-multi']
    ).toEqual({
      'repo-a': 'generating',
      'repo-b': 'generating',
    });
  });
});
