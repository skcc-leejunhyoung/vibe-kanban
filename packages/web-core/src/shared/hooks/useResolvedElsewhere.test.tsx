import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrMerge, RepoBranchStatus } from 'shared/types';
import { workspacesApi } from '@/shared/lib/api';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { branchStatusKeys } from './useBranchStatus';
import {
  RESOLVED_ELSEWHERE_CLOSE_MS,
  RESOLVED_ELSEWHERE_POLL_MS,
  conflictsResolved,
  divergenceResolved,
  openPrAppeared,
  useResolvedElsewhere,
} from './useResolvedElsewhere';

// Let Query's interval scheduler run as it does in the browser.
vi.hoisted(() => {
  Object.assign(globalThis, { window: new EventTarget() });
});

vi.mock('@/shared/lib/api', () => ({
  workspacesApi: { getBranchStatus: vi.fn() },
}));

function status(over: Partial<RepoBranchStatus> = {}): RepoBranchStatus {
  return {
    repo_id: 'repo',
    repo_name: 'widgets',
    repo_missing: false,
    commits_behind: 0,
    commits_ahead: 1,
    has_uncommitted_changes: false,
    head_oid: 'abc',
    uncommitted_count: 0,
    untracked_count: 0,
    target_branch_name: 'main',
    remote_commits_behind: 0,
    remote_commits_ahead: 0,
    target_remote_commits_ahead: 0,
    target_remote_commits_behind: 0,
    work_branch_has_remote: true,
    merges: [],
    is_rebase_in_progress: false,
    conflict_op: null,
    conflicted_files: [],
    is_target_remote: false,
    ...over,
  };
}

function openPr(id: string, head: string | null): { type: 'pr' } & PrMerge {
  return {
    type: 'pr',
    id,
    workspace_id: 'ws',
    repo_id: 'repo',
    created_at: '2026-01-01T00:00:00Z',
    target_branch_name: 'main',
    head_branch_name: head,
    head_commits_ahead: 1,
    head_commits_behind: 0,
    pr_info: {
      number: BigInt(7),
      url: 'https://github.com/acme/widgets/pull/7',
      status: 'open',
      merged_at: null,
      merge_commit_sha: null,
    },
  };
}

describe('what counts as handled elsewhere', () => {
  it('a diverged branch is resolved once the remote has nothing the local lacks', () => {
    expect(divergenceResolved(status({ remote_commits_behind: 3 }))).toBe(
      false
    );
    expect(divergenceResolved(status({ remote_commits_behind: 0 }))).toBe(true);
    // Unknown (no remote) never counts as resolved.
    expect(divergenceResolved(status({ remote_commits_behind: null }))).toBe(
      false
    );
    expect(
      divergenceResolved(
        status({ remote_commits_behind: 3, target_remote_commits_behind: 0 }),
        true
      )
    ).toBe(true);
  });

  it('conflicts are resolved when no file conflicts and no rebase remains', () => {
    expect(conflictsResolved(status({ conflicted_files: ['a.rs'] }))).toBe(
      false
    );
    expect(conflictsResolved(status({ is_rebase_in_progress: true }))).toBe(
      false
    );
    expect(conflictsResolved(status())).toBe(true);
  });

  it('a new open PR for the head counts; PRs known at open time do not', () => {
    const baseline = status({ merges: [openPr('old', 'feature')] });
    const now = status({
      merges: [openPr('old', 'feature'), openPr('new', 'feature')],
    });
    expect(openPrAppeared(now, baseline, 'feature')?.id).toBe('new');
    expect(openPrAppeared(now, baseline, 'other')).toBeUndefined();
    // Empty head = the work branch; legacy rows without a head match it.
    expect(
      openPrAppeared(status({ merges: [openPr('legacy', null)] }), status(), '')
        ?.id
    ).toBe('legacy');
    expect(openPrAppeared(baseline, baseline, 'feature')).toBeUndefined();
  });
});

describe('useResolvedElsewhere', () => {
  let dom: ReturnType<typeof installDomlessReact>;
  let client: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers();
    dom = installDomlessReact();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(workspacesApi.getBranchStatus).mockReset();
  });
  afterEach(async () => {
    await dom.unmount();
    client.clear();
    vi.useRealTimers();
  });

  async function mount(enabled: boolean, onResolved: () => void) {
    let resolved = false;
    function Probe() {
      resolved = useResolvedElsewhere({
        workspaceId: 'ws',
        repoId: 'repo',
        hostId: null,
        enabled,
        isResolved: (repo) => divergenceResolved(repo),
        onResolved,
      });
      return null;
    }
    await dom.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    );
    return () => resolved;
  }

  it('closes the dialog once a fresh status says the divergence is gone', async () => {
    let behind = 3;
    vi.mocked(workspacesApi.getBranchStatus).mockImplementation(async () => [
      status({ remote_commits_behind: behind }),
    ]);
    const onResolved = vi.fn();
    const resolved = await mount(true, onResolved);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(resolved()).toBe(false);

    // Someone else (the Autopilot) pulled and pushed in the meantime.
    behind = 0;
    await act(() =>
      vi.advanceTimersByTimeAsync(RESOLVED_ELSEWHERE_POLL_MS + 1)
    );
    expect(resolved()).toBe(true);
    expect(onResolved).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(RESOLVED_ELSEWHERE_CLOSE_MS));
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('does not trust a cached status older than the dialog', async () => {
    // The cache still says "in sync" from before the push was rejected.
    client.setQueryData(branchStatusKeys.byWorkspace('ws', null), [
      status({ remote_commits_behind: 0 }),
    ]);
    vi.mocked(workspacesApi.getBranchStatus).mockImplementation(async () => [
      status({ remote_commits_behind: 3 }),
    ]);
    const onResolved = vi.fn();
    const resolved = await mount(true, onResolved);
    expect(resolved()).toBe(false);
    await act(() =>
      vi.advanceTimersByTimeAsync(RESOLVED_ELSEWHERE_POLL_MS + 1)
    );
    expect(resolved()).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('stays quiet while disabled', async () => {
    vi.mocked(workspacesApi.getBranchStatus).mockImplementation(async () => [
      status({ remote_commits_behind: 0 }),
    ]);
    const onResolved = vi.fn();
    const resolved = await mount(false, onResolved);
    await act(() =>
      vi.advanceTimersByTimeAsync(RESOLVED_ELSEWHERE_POLL_MS + 1)
    );
    expect(resolved()).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
  });
});
