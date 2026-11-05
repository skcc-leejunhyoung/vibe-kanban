import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installFakeDomReact } from '@/shared/lib/electric/electricTestKit';
import {
  ProjectContext,
  type ProjectContextValue,
} from '@/shared/hooks/useProjectContext';
import { issuePrsApi } from '@/shared/lib/api';
import { CreateChatBoxContainer } from './CreateChatBoxContainer';

type ChatProps = {
  onSend: () => Promise<void>;
  sendDisabled: boolean;
  secondaryAction: { onClick: () => Promise<void>; disabled: boolean };
};
const env = vi.hoisted(() => ({
  chat: null as ChatProps | null,
  create: vi.fn(),
  only: vi.fn(),
  repos: [{ id: 'repo-test', name: 'Widgets' }],
}));
vi.mock('@vibe/ui/components/CreateChatBox', () => ({
  CreateChatBox: (props: ChatProps) => {
    env.chat = props;
    return null;
  },
}));
vi.mock('@/shared/lib/api', () => ({
  issuePrsApi: { getPrInfo: vi.fn() },
  workspacesApi: { stop: vi.fn() },
}));
vi.mock('@/features/create-mode/model/useCreateMode', () => ({
  useCreateMode: () => ({
    repos: env.repos,
    targetBranches: { 'repo-test': 'main', 'repo-other': 'main' },
    targetBranchModes: {},
    message: 'Synthetic review description',
    hasInitialValue: true,
    hasResolvedInitialRepoDefaults: true,
    linkedIssue: { remoteProjectId: 'project-test', issueId: 'issue-test' },
    workingBranch: { mode: 'auto' },
    clearDraft: vi.fn(),
    setAttachments: vi.fn(),
    setMessage: vi.fn(),
    setExecutorConfig: vi.fn(),
  }),
}));
vi.mock('@/shared/hooks/useCreateWorkspace', () => ({
  useCreateWorkspace: () => ({
    createWorkspace: { mutateAsync: env.create },
    createWorkspaceOnly: { mutateAsync: env.only },
  }),
}));
vi.mock('@/shared/hooks/useUserSystem', () => ({
  useUserSystem: () => ({ profiles: {}, config: null }),
}));
vi.mock('@/shared/hooks/useExecutorConfig', () => ({
  useExecutorConfig: () => ({
    effectiveExecutor: 'CODEX',
    executorConfig: { executor: 'CODEX' },
    executorOptions: [],
    variantOptions: [],
    presetOptions: [],
  }),
}));
vi.mock('@/shared/hooks/useCreateAttachments', () => ({
  useCreateAttachments: () => ({
    getAttachmentIds: () => [],
    clearAttachments: vi.fn(),
    uploadFiles: vi.fn(),
  }),
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => 'test-host',
}));
vi.mock('@/shared/components/workspace-panes/PaneActiveContext', () => ({
  useIsActivePane: () => true,
}));
vi.mock('react-dropzone', () => ({
  useDropzone: () => ({ getRootProps: () => ({}), getInputProps: () => ({}) }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/components/WYSIWYGEditor', () => ({ default: () => null }));
vi.mock('@/shared/components/AgentIcon', () => ({ AgentIcon: () => null }));
vi.mock('@/shared/components/ChatUsageIndicator', () => ({
  ChatUsageIndicator: () => null,
}));
vi.mock('@/shared/components/ModelSelectorContainer', () => ({
  ModelSelectorContainer: () => null,
}));
vi.mock('@/shared/dialogs/settings/SettingsDialog', () => ({
  SettingsDialog: { show: vi.fn() },
}));
vi.mock('./CreateModeRepoPickerBar', () => ({
  CreateModeRepoPickerBar: () => null,
}));
vi.mock('./ReviewModeBanner', () => ({ ReviewModeBanner: () => null }));
vi.mock('./GithubLinkedBranchBanner', () => ({
  GithubLinkedBranchBanner: () => null,
}));

let dom: ReturnType<typeof installFakeDomReact>;
let client: QueryClient;
const detail = {
  number: 12n,
  url: 'https://github.com/example/widgets/pull/12',
  status: 'open' as const,
  title: 'Synthetic PR',
  head_branch: 'topic',
  base_branch: 'main',
  merged_at: null,
  merge_commit_sha: null,
};
beforeEach(() => {
  dom = installFakeDomReact();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  env.chat = null;
  env.repos = [{ id: 'repo-test', name: 'Widgets' }];
  env.create
    .mockReset()
    .mockResolvedValue({ workspace: { id: 'workspace-test' } });
  env.only
    .mockReset()
    .mockResolvedValue({ workspace: { id: 'workspace-test' } });
  vi.mocked(issuePrsApi.getPrInfo)
    .mockReset()
    .mockResolvedValue({ success: true, data: detail });
});
afterEach(async () => {
  await dom.unmount();
  client.clear();
  vi.unstubAllGlobals();
});
async function render() {
  const context = {
    projectId: 'project-test',
    reviewTags: { isLoading: false, error: null, retry: vi.fn() },
    reviewPullRequests: { isLoading: false, error: null, retry: vi.fn() },
    getTagObjectsForIssue: () => [{ name: 'review' }],
    getPullRequestsForIssue: () => [{ url: detail.url }],
  } as unknown as ProjectContextValue;
  await dom.render(
    <QueryClientProvider client={client}>
      <ProjectContext.Provider value={context}>
        <CreateChatBoxContainer onWorkspaceCreated={vi.fn()} />
      </ProjectContext.Provider>
    </QueryClientProvider>
  );
}

it.each(['pending', 'error', 'multiple-repos'] as const)(
  'blocks both buttons and their direct handlers when review is %s',
  async (condition) => {
    if (condition === 'pending')
      vi.mocked(issuePrsApi.getPrInfo).mockImplementation(
        () => new Promise(() => {})
      );
    if (condition === 'error')
      vi.mocked(issuePrsApi.getPrInfo).mockRejectedValue(
        new Error('synthetic error')
      );
    if (condition === 'multiple-repos')
      env.repos.push({ id: 'repo-other', name: 'Other' });
    await render();
    if (condition === 'error')
      await vi.waitFor(() =>
        expect(
          client
            .getQueryCache()
            .getAll()
            .some((q) => q.state.status === 'error')
        ).toBe(true)
      );
    await vi.waitFor(() => expect(env.chat?.sendDisabled).toBe(true));
    expect(env.chat?.secondaryAction.disabled).toBe(true);
    await act(async () => {
      await env.chat!.onSend();
      await env.chat!.secondaryAction.onClick();
    });
    expect(env.create).not.toHaveBeenCalled();
    expect(env.only).not.toHaveBeenCalled();
  }
);

it.each(['only', 'start'] as const)(
  'sends the official review payload and matching issue through %s',
  async (mode) => {
    await render();
    await vi.waitFor(() => expect(env.chat?.sendDisabled).toBe(false));
    await act(async () => {
      await (mode === 'only'
        ? env.chat!.secondaryAction.onClick()
        : env.chat!.onSend());
    });
    const create = mode === 'only' ? env.only : env.create;
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        linkToIssue: { remoteProjectId: 'project-test', issueId: 'issue-test' },
        data: expect.objectContaining({
          linked_issue: {
            remote_project_id: 'project-test',
            issue_id: 'issue-test',
          },
          pr_review: expect.objectContaining({
            repo_id: 'repo-test',
            head_branch: 'topic',
            base_branch: 'main',
            pr_number: 12n,
            pr_url: detail.url,
          }),
        }),
      })
    );
    if (mode === 'start')
      expect(create.mock.calls[0][0].data.prompt).toContain(
        'Review the checked-out PR.'
      );
  }
);
