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
