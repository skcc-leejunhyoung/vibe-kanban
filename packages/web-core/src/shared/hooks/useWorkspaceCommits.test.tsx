import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RepoBranchStatus } from 'shared/types';

const api = vi.hoisted(() => ({
  getBranchStatus: vi.fn(),
  getCommits: vi.fn(),
}));

vi.mock('@/shared/lib/api', () => ({
  workspacesApi: {
    getBranchStatus: api.getBranchStatus,
    getCommits: api.getCommits,
  },
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => null,
  getCurrentHostId: () => null,
}));

const { branchStatusKeys } = await import('./useBranchStatus');
const { useWorkspaceCommits } = await import('./useWorkspaceCommits');

const status = (
  head_oid: string,
  commits_ahead: number,
  has_uncommitted_changes = false
): RepoBranchStatus =>
  ({
    repo_id: 'repo-1',
    head_oid,
    commits_ahead,
    has_uncommitted_changes,
  }) as unknown as RepoBranchStatus;

let root: Root;
let queryClient: QueryClient;
let branchStatus: RepoBranchStatus[];

beforeEach(() => {
  branchStatus = [status('aaa', 1)];
  api.getBranchStatus.mockImplementation(async () => branchStatus);
  api.getCommits.mockImplementation(async () => []);

  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // These probes render no DOM nodes — only the root surface is needed, while
  // React's real effects, context and query subscriptions still run.
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), {
      nodeType: 9,
      visibilityState: 'visible',
      activeElement: null,
    })
  );
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      document,
      setTimeout,
      clearTimeout,
      // React's commit phase does `el instanceof win.HTMLIFrameElement`.
      HTMLIFrameElement: class {},
    })
  );
  const container = Object.assign(new EventTarget(), {
    nodeType: 1,
    tagName: 'DIV',
    ownerDocument: document,
  });
  root = createRoot(container as unknown as HTMLElement);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(node: ReactNode) {
  await act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    )
  );
  await settle();
}

/** Let the branch-status fetch resolve, then the effect chain it triggers. */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function refreshBranchStatus() {
  void queryClient.invalidateQueries({
    queryKey: branchStatusKeys.byWorkspace('ws-1', null),
  });
  await settle();
}

function Probe() {
  useWorkspaceCommits('ws-1');
  return null;
}

describe('useWorkspaceCommits branch-tip trigger', () => {
  it('fetches both the commit list and branch status on mount', async () => {
    await render(<Probe />);
    expect(api.getCommits).toHaveBeenCalledTimes(1);
    expect(api.getBranchStatus).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when branch status moves but the tip does not', async () => {
    await render(<Probe />);
    expect(api.getCommits).toHaveBeenCalledTimes(1);

    // The agent edited the worktree: uncommitted state changed, no new commit.
    branchStatus = [status('aaa', 1, true)];
    await refreshBranchStatus();

    expect(api.getBranchStatus).toHaveBeenCalledTimes(2);
    expect(api.getCommits).toHaveBeenCalledTimes(1);
  });

  it('refetches when a commit moves the tip', async () => {
    await render(<Probe />);
    expect(api.getCommits).toHaveBeenCalledTimes(1);

    branchStatus = [status('bbb', 2)];
    await refreshBranchStatus();

    expect(api.getCommits).toHaveBeenCalledTimes(2);
  });

  it('refetches when a merge drops the ahead-of-base count', async () => {
    await render(<Probe />);
    expect(api.getCommits).toHaveBeenCalledTimes(1);

    // Merging into the target leaves HEAD alone but empties commits_ahead.
    branchStatus = [status('aaa', 0)];
    await refreshBranchStatus();

    expect(api.getCommits).toHaveBeenCalledTimes(2);
  });

  it('does not refetch on a StrictMode mount over a warm branch status', async () => {
    // Revisiting a workspace renders with branch status already cached, so the
    // first signature the effect sees is a real tip — and StrictMode runs that
    // mount effect twice. Only the tip *moving* may refetch.
    queryClient.setQueryData(branchStatusKeys.byWorkspace('ws-1', null), [
      status('aaa', 1),
    ]);

    await act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <StrictMode>
            <Probe />
          </StrictMode>
        </QueryClientProvider>
      )
    );
    await settle();

    expect(api.getCommits).toHaveBeenCalledTimes(1);
  });

  it('collapses the refetch to one request across several mounted callers', async () => {
    await render(
      <>
        <Probe />
        <Probe />
        <Probe />
      </>
    );
    const afterMount = api.getCommits.mock.calls.length;

    branchStatus = [status('bbb', 2)];
    await refreshBranchStatus();

    // cancelRefetch: false — the three observers share one in-flight fetch
    // instead of aborting and restarting each other's.
    expect(api.getCommits).toHaveBeenCalledTimes(afterMount + 1);
  });
});
