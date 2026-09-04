import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerateSpecRequest } from 'shared/types';
import {
  approvalsApi,
  attachmentsApi,
  executionProcessesApi,
  issuePrsApi,
  queueApi,
  repoApi,
  searchApi,
  sessionsApi,
  specApi,
  tagsApi,
  workspacesApi,
} from './api';
import { setLocalApiTransport } from './localApiTransport';

function apiResponse<T>(data: T): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('host-aware task APIs', () => {
  afterEach(() => {
    vi.useRealTimers();
    setLocalApiTransport(null);
  });

  it('routes task tag CRUD to the explicitly selected host', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/tags') && !path.includes('/tags/')) {
        return apiResponse([]);
      }
      if (path.endsWith('/tags/tag-1')) {
        return apiResponse(undefined);
      }
      return apiResponse({
        id: 'tag-1',
        tag_name: 'review',
        content: 'Review this task',
        created_at: '',
        updated_at: '',
      });
    });
    setLocalApiTransport({
      request,
      openWebSocket: vi.fn(),
    });

    await tagsApi.list(undefined, 'host-1');
    await tagsApi.create(
      { tag_name: 'review', content: 'Review this task' },
      'host-1'
    );
    await tagsApi.update(
      'tag-1',
      { tag_name: 'review', content: 'Updated review task' },
      'host-1'
    );
    await tagsApi.delete('tag-1', 'host-1');

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/host/host-1/tags',
      '/api/host/host-1/tags',
      '/api/host/host-1/tags/tag-1',
      '/api/host/host-1/tags/tag-1',
    ]);
  });

  it('routes multi-repository file search to the selected host', async () => {
    const request = vi.fn(async () => apiResponse([]));
    setLocalApiTransport({
      request,
      openWebSocket: vi.fn(),
    });

    await searchApi.searchFiles(
      ['repo-1'],
      'query',
      undefined,
      undefined,
      'host-2'
    );

    expect(request.mock.calls[0]?.[0]).toBe(
      '/api/host/host-2/search?q=query&repo_ids=repo-1'
    );
  });

  it('routes diverged branch reconciliation to the selected host', async () => {
    const request = vi.fn(async () => apiResponse(undefined));
    setLocalApiTransport({
      request,
      openWebSocket: vi.fn(),
    });

    await workspacesApi.pullAndPush(
      'workspace-1',
      { repo_id: 'repo-1' },
      'host-3'
    );
    await workspacesApi.pullAndPushTargetBranch(
      'workspace-1',
      'repo-1',
      'host-3'
    );
    await workspacesApi.push('workspace-1', { repo_id: 'repo-1' }, 'host-3');
    await workspacesApi.forcePush(
      'workspace-1',
      { repo_id: 'repo-1' },
      'host-3'
    );
    await workspacesApi.mergeRemote(
      'workspace-1',
      { repo_id: 'repo-1' },
      'host-3'
    );
    await workspacesApi.resetToRemote(
      'workspace-1',
      { repo_id: 'repo-1', confirm_discard: true },
      'host-3'
    );
    await workspacesApi.merge('workspace-1', { repo_id: 'repo-1' }, 'host-3');
    await workspacesApi.commit('workspace-1', { repo_id: 'repo-1' }, 'host-3');
    await workspacesApi.rebase(
      'workspace-1',
      {
        repo_id: 'repo-1',
        old_base_branch: null,
        new_base_branch: null,
      },
      'host-3'
    );
    await workspacesApi.change_target_branch(
      'workspace-1',
      { repo_id: 'repo-1', new_target_branch: 'main' },
      'host-3'
    );
    await workspacesApi.renameBranch('workspace-1', 'feature', 'host-3');

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/host/host-3/workspaces/workspace-1/git/pull-and-push',
      '/api/host/host-3/workspaces/workspace-1/git/target-branch/pull-and-push',
      '/api/host/host-3/workspaces/workspace-1/git/push',
      '/api/host/host-3/workspaces/workspace-1/git/push/force',
      '/api/host/host-3/workspaces/workspace-1/git/merge-remote',
      '/api/host/host-3/workspaces/workspace-1/git/reset-to-remote',
      '/api/host/host-3/workspaces/workspace-1/git/merge',
      '/api/host/host-3/workspaces/workspace-1/git/commit',
      '/api/host/host-3/workspaces/workspace-1/git/rebase',
      '/api/host/host-3/workspaces/workspace-1/git/target-branch',
      '/api/host/host-3/workspaces/workspace-1/git/branch',
    ]);
  });

  it('routes PR draft persistence to the selected host', async () => {
    const request = vi.fn(async () => apiResponse(null));
    setLocalApiTransport({ request, openWebSocket: vi.fn() });

    await workspacesApi.getPrDraft('workspace-1', 'repo-1', 'host-5');
    await workspacesApi.savePrDraft(
      'workspace-1',
      { repo_id: 'repo-1', title: 'Title', body: 'Body' },
      'host-5'
    );
    await workspacesApi.deletePrDraft('workspace-1', 'repo-1', 'host-5');

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/host/host-5/workspaces/workspace-1/pull-requests/draft?repo_id=repo-1',
      '/api/host/host-5/workspaces/workspace-1/pull-requests/draft',
      '/api/host/host-5/workspaces/workspace-1/pull-requests/draft?repo_id=repo-1',
    ]);
  });

  it('routes PR comments to the selected host', async () => {
    const request = vi.fn(async () => apiResponse({ comments: [] }));
    setLocalApiTransport({ request, openWebSocket: vi.fn() });

    await workspacesApi.getPrComments('workspace-1', 'repo-1', 42, 'host-6');

    expect(request.mock.calls[0]?.[0]).toBe(
      '/api/host/host-6/workspaces/workspace-1/pull-requests/comments?repo_id=repo-1&pr_number=42'
    );
  });

  it('routes dev server and process operations to the selected host', async () => {
    const request = vi.fn(async () => apiResponse([]));
    setLocalApiTransport({ request, openWebSocket: vi.fn() });

    await workspacesApi.startDevServer('workspace-1', 'host-7');
    await workspacesApi.getDevServers('workspace-1', 'host-7');
    await workspacesApi.stop('workspace-1', 'host-7');
    await executionProcessesApi.getDetails('process-1', 'host-7');
    await executionProcessesApi.getRepoStates('process-1', 'host-7');
    await executionProcessesApi.stopExecutionProcess('process-1', 'host-7');

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/host/host-7/workspaces/workspace-1/execution/dev-server/start',
      '/api/host/host-7/workspaces/workspace-1/execution/dev-servers',
      '/api/host/host-7/workspaces/workspace-1/execution/stop',
      '/api/host/host-7/execution-processes/process-1',
      '/api/host/host-7/execution-processes/process-1/repo-states',
      '/api/host/host-7/execution-processes/process-1/stop',
    ]);
  });

  it('routes session messages to the selected host', async () => {
    const request = vi.fn(async () => apiResponse({}));
    setLocalApiTransport({ request, openWebSocket: vi.fn() });
    const followUp = {
      prompt: 'continue',
      executor_config: null,
      retry_process_id: null,
      force_when_dirty: null,
      perform_git_reset: null,
    };

    await sessionsApi.followUp('session-1', followUp, 'host-8');
    await sessionsApi.handoff(
      'session-1',
      { prompt: 'handoff', executor_config: null },
      'host-8'
    );
    await sessionsApi.reset(
      'session-1',
      {
        process_id: 'process-1',
        force_when_dirty: false,
        perform_git_reset: true,
      },
      'host-8'
    );
    await sessionsApi.getAutoResume('session-1', 'host-8');
    await sessionsApi.setAutoResume('session-1', true, 'host-8');
    await queueApi.queue(
      'session-1',
      { message: 'later', executor_config: null },
      'host-8'
    );
    await queueApi.steer(
      'session-1',
      { message: 'now', executor_config: null },
      'host-8'
    );
    await queueApi.steerQueued('session-1', 'message-1', 'host-8');
    await queueApi.reorder('session-1', ['message-1'], 'host-8');
    await queueApi.cancelOne('session-1', 'message-1', 'host-8');
    await queueApi.cancel('session-1', 'host-8');
    await queueApi.getStatus('session-1', 'host-8');

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/host/host-8/sessions/session-1/follow-up',
      '/api/host/host-8/sessions/session-1/handoff',
      '/api/host/host-8/sessions/session-1/reset',
      '/api/host/host-8/sessions/session-1/auto-resume',
      '/api/host/host-8/sessions/session-1/auto-resume',
      '/api/host/host-8/sessions/session-1/queue',
      '/api/host/host-8/sessions/session-1/queue/steer',
      '/api/host/host-8/sessions/session-1/queue/steer-queued',
      '/api/host/host-8/sessions/session-1/queue/reorder',
      '/api/host/host-8/sessions/session-1/queue?message_id=message-1',
      '/api/host/host-8/sessions/session-1/queue',
      '/api/host/host-8/sessions/session-1/queue',
    ]);
  });

  it('routes workspace creation to the selected host', async () => {
    const request = vi.fn(async () => apiResponse({}));
    setLocalApiTransport({ request, openWebSocket: vi.fn() });

    await workspacesApi.createOnly({} as never, 'host-9');
    await workspacesApi.createAndStart({} as never, 'host-9');
    await workspacesApi.createFromPr({} as never, 'host-9');
    await repoApi.listRemotes('repo-1', 'host-9');
    await repoApi.listOpenPrs('repo-1', 'origin', 'host-9');
    await repoApi.listPullRequestSummaries('repo-1', true, false, 'host-9');
    await issuePrsApi.getPrInfo('https://example.com/pull/1', 'host-9');
    await issuePrsApi.getPrComments('https://example.com/pull/1', 1, 'host-9');
    await issuePrsApi.setPrReviewThreadResolved(
      'https://example.com/pull/1',
      1,
      'thread-1',
      true,
      'host-9'
    );

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/host/host-9/workspaces/create',
      '/api/host/host-9/workspaces/start',
      '/api/host/host-9/workspaces/from-pr',
      '/api/host/host-9/repos/repo-1/remotes',
      '/api/host/host-9/repos/repo-1/prs?remote=origin',
      '/api/host/host-9/repos/repo-1/pull-requests?involves_me=true&refresh=false',
      '/api/host/host-9/repos/pr-info?url=https%3A%2F%2Fexample.com%2Fpull%2F1',
      '/api/host/host-9/repos/pr-comments?url=https%3A%2F%2Fexample.com%2Fpull%2F1&pr_number=1',
      '/api/host/host-9/repos/pr-comments/resolve',
    ]);
  });

  it('routes Git reconciliation and PR links to the selected host', async () => {
    const request = vi.fn(async () => apiResponse({}));
    setLocalApiTransport({ request, openWebSocket: vi.fn() });

    await workspacesApi.pull('workspace-1', {} as never, 'host-7');
    await workspacesApi.updateFromBase('workspace-1', {} as never, 'host-7');
    await workspacesApi.updateTargetBranchFromBase(
      'workspace-1',
      {} as never,
      'host-7'
    );
    await workspacesApi.fetchTargetBranch('workspace-1', 'repo-1', 'host-7');
    await workspacesApi.pullTargetBranch('workspace-1', 'repo-1', 'host-7');
    await workspacesApi.abortConflicts('workspace-1', {} as never, 'host-7');
    await workspacesApi.continueRebase('workspace-1', {} as never, 'host-7');
    await workspacesApi.listAttachablePrs(
      'workspace-1',
      'repo-1',
      'feature',
      'host-7'
    );
    await workspacesApi.attachPr('workspace-1', {} as never, 'host-7');
    await workspacesApi.unlinkPr('workspace-1', {} as never, 'host-7');

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/host/host-7/workspaces/workspace-1/git/pull',
      '/api/host/host-7/workspaces/workspace-1/git/update-from-base',
      '/api/host/host-7/workspaces/workspace-1/git/target-branch/update-from-base',
      '/api/host/host-7/workspaces/workspace-1/git/target-branch/fetch',
      '/api/host/host-7/workspaces/workspace-1/git/target-branch/pull',
      '/api/host/host-7/workspaces/workspace-1/git/conflicts/abort',
      '/api/host/host-7/workspaces/workspace-1/git/rebase/continue',
      '/api/host/host-7/workspaces/workspace-1/pull-requests/attach?repo_id=repo-1&head_branch=feature',
      '/api/host/host-7/workspaces/workspace-1/pull-requests/attach',
      '/api/host/host-7/workspaces/workspace-1/pull-requests/unlink',
    ]);
  });

  it('routes attachments and approvals to the selected host', async () => {
    const request = vi.fn(async () => apiResponse({}));
    setLocalApiTransport({ request, openWebSocket: vi.fn() });

    await attachmentsApi.upload(
      new File(['image'], 'image.png', { type: 'image/png' }),
      'host-6'
    );
    await approvalsApi.respond(
      'approval-1',
      {
        execution_process_id: 'process-1',
        status: { status: 'approved' },
      },
      undefined,
      'host-6'
    );

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/host/host-6/attachments/upload',
      '/api/host/host-6/approvals/approval-1/respond',
    ]);
  });

  it('routes workspace integrations to the selected host', async () => {
    const request = vi.fn(async () => apiResponse({}));
    setLocalApiTransport({ request, openWebSocket: vi.fn() });

    await workspacesApi.openEditor('workspace-1', {} as never, 'host-5');
    await workspacesApi.setupGhCli('workspace-1', 'host-5');

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/host/host-5/workspaces/workspace-1/integration/editor/open',
      '/api/host/host-5/workspaces/workspace-1/integration/github/cli/setup',
    ]);
  });

  it('cancels an aborted remote spec generation job', async () => {
    const request = vi.fn(async (path: string) =>
      apiResponse(path.endsWith('/start') ? { job_id: 'job-1' } : undefined)
    );
    setLocalApiTransport({ request, openWebSocket: vi.fn() });
    const controller = new AbortController();
    const generation = specApi.generate(
      {} as GenerateSpecRequest,
      controller.signal,
      'host-4'
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(generation).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).toHaveBeenLastCalledWith(
      '/api/host/host-4/spec/generate/status?job_id=job-1',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('times out and cancels a stuck remote PR generation job', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/start')) return apiResponse({ job_id: 'job-1' });
      if (init?.method === 'DELETE') return apiResponse(undefined);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      });
    });
    setLocalApiTransport({ request, openWebSocket: vi.fn() });

    const generation = workspacesApi.generatePrDescription(
      'workspace-1',
      { repo_id: 'repo-1' } as never,
      undefined,
      'host-4'
    );
    const rejection = expect(generation).rejects.toThrow(
      'PR description generation timed out.'
    );

    await vi.advanceTimersByTimeAsync(360_000);

    await rejection;
    expect(request).toHaveBeenLastCalledWith(
      expect.stringContaining('/pull-requests/generate/status?job_id=job-1'),
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});
