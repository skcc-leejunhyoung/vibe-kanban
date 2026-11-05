import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  CreateAndStartWorkspaceRequest,
  Workspace,
  Session,
} from 'shared/types';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { workspacesApi } from '@/shared/lib/api';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { useCreateWorkspace } from './useCreateWorkspace';

vi.mock('@/shared/lib/api', () => ({
  workspacesApi: {
    createOnly: vi.fn(),
    createAndStart: vi.fn(),
    linkToIssue: vi.fn(),
  },
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => 'test-host',
}));
vi.mock('@/shared/hooks/useWorkspaceSessions', () => ({
  selectWorkspaceSession: vi.fn(),
}));
vi.mock('@/shared/providers/executionProcessScope', () => ({
  seedOptimisticProcess: vi.fn(),
}));
vi.mock('@vibe/ui/components/ConfirmDialog', () => ({
  ConfirmDialog: { show: vi.fn() },
}));
vi.mock('@/i18n/config', () => ({ default: { t: (key: string) => key } }));

let dom: ReturnType<typeof installDomlessReact>;
let client: QueryClient;
let result: ReturnType<typeof useCreateWorkspace>;
const workspace = { id: 'test-workspace' } as Workspace;
const session = { id: 'test-session', workspace_id: workspace.id } as Session;
const data = {
  name: 'Synthetic review',
  repos: [
    {
      repo_id: 'test-repo',
      target_branch: 'main',
      target_branch_mode: 'existing',
    },
  ],
  pr_review: {
    repo_id: 'test-repo',
    pr_number: 12n,
    pr_url: 'https://github.com/example/widgets/pull/12',
    pr_title: 'Synthetic PR',
    head_branch: 'topic',
    base_branch: 'main',
    remote_name: null,
  },
  linked_issue: { issue_id: 'test-issue', remote_project_id: 'test-project' },
  prompt: 'Review the checked-out PR.',
  executor_config: { executor: 'CODEX' },
  working_branch: { mode: 'auto' },
  attachment_ids: [],
} as unknown as CreateAndStartWorkspaceRequest;
const linkToIssue = { remoteProjectId: 'test-project', issueId: 'test-issue' };

beforeEach(async () => {
  dom = installDomlessReact();
  client = new QueryClient();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(workspacesApi.createOnly).mockResolvedValue({ workspace });
  vi.mocked(workspacesApi.createAndStart).mockResolvedValue({
    workspace,
    session,
    execution_process: null,
  });
  function Probe() {
    result = useCreateWorkspace();
    return null;
  }
  await dom.render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
});
afterEach(async () => {
  await dom.unmount();
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['createWorkspaceOnly', 'createWorkspace'] as const)(
  'preserves review and issue identity through %s, including delayed link failure',
  async (mode) => {
    let rejectLink!: (error: Error) => void;
    vi.mocked(workspacesApi.linkToIssue).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectLink = reject;
        })
    );
    await act(async () => {
      const created = await result[mode].mutateAsync({ data, linkToIssue });
      expect(created.workspace.id).toBe('test-workspace');
    });
    const create =
      mode === 'createWorkspaceOnly'
        ? workspacesApi.createOnly
        : workspacesApi.createAndStart;
    const unused =
      mode === 'createWorkspaceOnly'
        ? workspacesApi.createAndStart
        : workspacesApi.createOnly;
    expect(create).toHaveBeenCalledExactlyOnceWith(data, 'test-host');
    expect(unused).not.toHaveBeenCalled();
    expect(workspacesApi.linkToIssue).toHaveBeenCalledExactlyOnceWith(
      'test-workspace',
      'test-project',
      'test-issue',
      'test-host'
    );
    expect(ConfirmDialog.show).not.toHaveBeenCalled();
    await act(() => rejectLink(new Error('synthetic link unavailable')));
    expect(ConfirmDialog.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('linkErrorRecovery'),
      })
    );
    expect(create).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(result[mode].isSuccess).toBe(true));
  }
);
