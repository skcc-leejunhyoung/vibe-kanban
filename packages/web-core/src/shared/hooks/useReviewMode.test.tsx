import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PullRequestDetail } from 'shared/types';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { issuePrsApi } from '@/shared/lib/api';
import { ProjectContext, type ProjectContextValue } from './useProjectContext';
import { useReviewMode, type ReviewModeState } from './useReviewMode';

const env = vi.hoisted(() => ({ host: null as string | null }));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => env.host,
}));
vi.mock('@/shared/lib/api', () => ({ issuePrsApi: { getPrInfo: vi.fn() } }));

const detail: PullRequestDetail = {
  number: 12n,
  url: 'https://github.com/example/widgets/pull/12',
  status: 'open',
  title: 'Synthetic change',
  base_branch: 'main',
  head_branch: 'topic',
  merged_at: null,
  merge_commit_sha: null,
};
const issue = { remoteProjectId: 'project-test', issueId: 'issue-test' };
let dom: ReturnType<typeof installDomlessReact>;
let client: QueryClient;
let context: ProjectContextValue;
let state: ReviewModeState;
beforeEach(() => {
  env.host = null;
  dom = installDomlessReact();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  context = {
    projectId: issue.remoteProjectId,
    reviewTags: { isLoading: false, error: null, retry: vi.fn() },
    reviewPullRequests: { isLoading: false, error: null, retry: vi.fn() },
    getTagObjectsForIssue: () => [{ id: 'tag', name: 'review' }],
    getPullRequestsForIssue: () => [{ url: detail.url }],
  } as unknown as ProjectContextValue;
  vi.mocked(issuePrsApi.getPrInfo)
    .mockReset()
    .mockResolvedValue({ success: true, data: detail });
});
afterEach(async () => {
  await dom.unmount();
  client.clear();
  vi.unstubAllGlobals();
});

function Probe({
  repoId,
  linked = issue,
}: {
  repoId?: string;
  linked?: typeof issue | null;
}) {
  state = useReviewMode(linked, repoId);
  return null;
}
async function render(
  repoId: string | undefined = 'repo-test',
  linked: typeof issue | null = issue
) {
  await dom.render(
    <QueryClientProvider client={client}>
      <ProjectContext.Provider value={context}>
        <Probe repoId={repoId} linked={linked} />
      </ProjectContext.Provider>
    </QueryClientProvider>
  );
}

it('blocks until tag and PR mapping sources have initialized, then resolves the official payload', async () => {
  context.reviewTags.isLoading = true;
  await render();
  expect(state.blocked).toBe(true);
  expect(issuePrsApi.getPrInfo).not.toHaveBeenCalled();
  context = {
    ...context,
    reviewTags: { ...context.reviewTags, isLoading: false },
    reviewPullRequests: { ...context.reviewPullRequests, isLoading: true },
  };
  await render();
  expect(state.status).toBe('loading');
  context = {
    ...context,
    reviewPullRequests: { ...context.reviewPullRequests, isLoading: false },
  };
  await render();
  await vi.waitFor(() => expect(state.status).toBe('ready'));
  expect(state.prReviewPayload).toMatchObject({
    repo_id: 'repo-test',
    pr_number: 12n,
    head_branch: 'topic',
    base_branch: 'main',
    pr_url: detail.url,
  });
});

it('ignores unrelated project errors and allows non-review creation', async () => {
  context = {
    ...context,
    error: { message: 'milestone unavailable' },
    getTagObjectsForIssue: () => [],
  };
  await render();
  expect(state.status).toBe('normal');
  expect(state.blocked).toBe(false);
  expect(issuePrsApi.getPrInfo).not.toHaveBeenCalled();
});

it.each(['transport', 'result'] as const)(
  'blocks a %s error and recovers only after a successful retry',
  async (kind) => {
    if (kind === 'transport')
      vi.mocked(issuePrsApi.getPrInfo).mockRejectedValue(
        new Error('synthetic error')
      );
    else
      vi.mocked(issuePrsApi.getPrInfo).mockResolvedValue({
        success: false,
        message: 'synthetic error',
      });
    await render();
    await vi.waitFor(() => expect(state.status).toBe('error'));
    expect(state.blocked).toBe(true);
    expect(state.prReviewPayload).toBeNull();
    vi.mocked(issuePrsApi.getPrInfo).mockResolvedValue({
      success: true,
      data: detail,
    });
    await act(() => state.retry());
    await vi.waitFor(() => expect(state.status).toBe('ready'));
  }
);

it('does not use a previous successful PR after refetch fails', async () => {
  await render();
  await vi.waitFor(() => expect(state.status).toBe('ready'));
  vi.mocked(issuePrsApi.getPrInfo).mockRejectedValue(
    new Error('refresh failed')
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['review-mode-pr'] });
  });
  await vi.waitFor(() => expect(state.status).toBe('error'));
  expect(state.blocked).toBe(true);
  expect(state.prReviewPayload).toBeNull();
});

it('requires one repository but permits explicit opt-out without a resolved PR', async () => {
  await render('');
  expect(state.status).toBe('repository-required');
  expect(state.canToggle).toBe(true);
  await act(() => state.setEnabled(false));
  expect(state.status).toBe('disabled');
  expect(state.blocked).toBe(false);
  expect(state.prReviewPayload).toBeNull();
  env.host = 'another-test-host';
  await render('');
  expect(state.enabled).toBe(true);
  expect(state.blocked).toBe(true);
});

it('distinguishes a successful empty result from failed metadata', async () => {
  context = { ...context, getPullRequestsForIssue: () => [] };
  await render();
  expect(state.status).toBe('no-pr');
  context = {
    ...context,
    reviewPullRequests: {
      ...context.reviewPullRequests,
      error: { status: 401, message: 'expired' },
    },
  };
  await render();
  expect(state.blocked).toBe(true);
  expect(state.requiresLogin).toBe(true);
});

it('does not carry a previous opt-out to another issue or use a mismatched project', async () => {
  await render();
  await act(() => state.setEnabled(false));
  await render('repo-test', { ...issue, issueId: 'new-issue' });
  expect(state.enabled).toBe(true);
  await render('repo-test', { ...issue, remoteProjectId: 'other-project' });
  expect(state.status).toBe('error');
  expect(state.prReviewPayload).toBeNull();
  await render('repo-test', null);
  expect(state.blocked).toBe(false);
});

it('discards the old PR payload while the new host is loading', async () => {
  await render();
  await vi.waitFor(() => expect(state.status).toBe('ready'));
  vi.mocked(issuePrsApi.getPrInfo).mockImplementation(
    () => new Promise(() => {})
  );
  env.host = 'new-synthetic-host';
  await render();
  expect(state.status).toBe('loading');
  expect(state.blocked).toBe(true);
  expect(state.prReviewPayload).toBeNull();
});

it('rebuilds the payload for the current repository while reusing URL-scoped PR metadata', async () => {
  await render();
  await vi.waitFor(() => expect(state.status).toBe('ready'));
  await render('new-synthetic-repo');
  expect(state.status).toBe('ready');
  expect(state.prReviewPayload?.repo_id).toBe('new-synthetic-repo');
  expect(issuePrsApi.getPrInfo).toHaveBeenCalledOnce();
});

it('allows a healthy background PR refresh using the current cached payload', async () => {
  await render();
  await vi.waitFor(() => expect(state.status).toBe('ready'));
  vi.mocked(issuePrsApi.getPrInfo).mockImplementation(
    () => new Promise(() => {})
  );
  await act(async () => {
    void client.invalidateQueries({ queryKey: ['review-mode-pr'] });
  });
  expect(state.status).toBe('ready');
  expect(state.blocked).toBe(false);
  expect(state.prReviewPayload?.repo_id).toBe('repo-test');
});

it('blocks when one of several linked PR lookups fails', async () => {
  context = {
    ...context,
    getPullRequestsForIssue: () => [
      { url: detail.url },
      { url: 'https://github.com/example/widgets/pull/13', status: 'open' },
    ],
  } as ProjectContextValue;
  vi.mocked(issuePrsApi.getPrInfo)
    .mockResolvedValueOnce({ success: true, data: detail })
    .mockRejectedValueOnce(new Error('Synthetic second PR failure'));
  await render();
  await vi.waitFor(() => expect(state.status).toBe('error'));
  expect(state.blocked).toBe(true);
  expect(state.prReviewPayload).toBeNull();
});

it('retains an explicit opt-out for the same issue through later metadata failures', async () => {
  await render();
  await vi.waitFor(() => expect(state.status).toBe('ready'));
  await act(() => state.setEnabled(false));
  context = {
    ...context,
    reviewTags: {
      ...context.reviewTags,
      error: { message: 'Synthetic tag outage', status: 503 },
    },
  };
  await render();
  expect(state.status).toBe('disabled');
  expect(state.blocked).toBe(false);
  expect(state.prReviewPayload).toBeNull();
});

it.each(['closed', 'merged'] as const)(
  'allows an accessible open PR when a historical %s PR lookup fails',
  async (status) => {
    const historicalUrl = 'https://github.com/synthetic/old-repo/pull/21';
    context = {
      ...context,
      getPullRequestsForIssue: () => [
        { url: historicalUrl, status },
        { url: detail.url, status: 'open' },
      ],
    } as ProjectContextValue;
    vi.mocked(issuePrsApi.getPrInfo).mockImplementation(async (url) => {
      if (url === historicalUrl)
        throw new Error('Historical repository unavailable');
      return { success: true, data: detail };
    });
    await render();
    await vi.waitFor(() => expect(state.status).toBe('ready'));
    expect(state.blocked).toBe(false);
    expect(state.prReviewPayload?.pr_url).toBe(detail.url);
  }
);

it('keeps a failed historical lookup blocking when no live open PR was resolved', async () => {
  context = {
    ...context,
    getPullRequestsForIssue: () => [{ url: detail.url, status: 'closed' }],
  } as ProjectContextValue;
  vi.mocked(issuePrsApi.getPrInfo).mockRejectedValue(
    new Error('Lookup unavailable')
  );
  await render();
  await vi.waitFor(() => expect(state.status).toBe('error'));
  expect(state.blocked).toBe(true);
});

it('does not wait for a pending historical PR once a live open PR resolves', async () => {
  const historicalUrl = 'https://github.com/synthetic/old-repo/pull/22';
  context = {
    ...context,
    getPullRequestsForIssue: () => [
      { url: historicalUrl, status: 'closed' },
      { url: detail.url, status: 'open' },
    ],
  } as ProjectContextValue;
  vi.mocked(issuePrsApi.getPrInfo).mockImplementation((url) =>
    url === historicalUrl
      ? new Promise(() => {})
      : Promise.resolve({ success: true, data: detail })
  );
  await render();
  await vi.waitFor(() => expect(state.status).toBe('ready'));
  expect(state.prReviewPayload?.pr_url).toBe(detail.url);
});

it('still discovers a reopened PR whose central status is closed', async () => {
  context = {
    ...context,
    getPullRequestsForIssue: () => [{ url: detail.url, status: 'closed' }],
  } as ProjectContextValue;
  await render();
  await vi.waitFor(() => expect(state.status).toBe('ready'));
  expect(state.prReviewPayload?.pr_url).toBe(detail.url);
});
