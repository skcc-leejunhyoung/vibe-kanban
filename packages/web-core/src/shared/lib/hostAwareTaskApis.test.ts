import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchApi, tagsApi, workspacesApi } from './api';
import { setLocalApiTransport } from './localApiTransport';

function apiResponse<T>(data: T): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('host-aware task APIs', () => {
  afterEach(() => {
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

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/host/host-3/workspaces/workspace-1/git/pull-and-push',
      '/api/host/host-3/workspaces/workspace-1/git/target-branch/pull-and-push',
    ]);
  });
});
