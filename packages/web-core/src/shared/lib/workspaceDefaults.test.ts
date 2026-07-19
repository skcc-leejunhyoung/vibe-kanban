import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from 'shared/remote-types';
import { repoApi, workspacesApi } from '@/shared/lib/api';
import { getValidProjectRepoDefaults } from '@/shared/hooks/useProjectRepoDefaults';
import { getWorkspaceDefaults } from './workspaceDefaults';

vi.mock('@/shared/lib/api', () => ({
  repoApi: {
    list: vi.fn(),
  },
  workspacesApi: {
    getRepos: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('@/shared/hooks/useProjectRepoDefaults', () => ({
  getValidProjectRepoDefaults: vi.fn(),
}));

const mockedRepoList = vi.mocked(repoApi.list);
const mockedWorkspaceRepos = vi.mocked(workspacesApi.getRepos);
const mockedWorkspaceGet = vi.mocked(workspacesApi.get);
const mockedProjectDefaults = vi.mocked(getValidProjectRepoDefaults);

describe('getWorkspaceDefaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRepoList.mockResolvedValue([]);
    mockedProjectDefaults.mockResolvedValue([]);
  });

  it('loads project repository defaults from the selected host', async () => {
    mockedRepoList.mockResolvedValue([{ id: 'repo-1' }] as Awaited<
      ReturnType<typeof repoApi.list>
    >);
    mockedProjectDefaults.mockResolvedValue([
      {
        repo_id: 'repo-1',
        target_branch: 'develop',
        create_target_branch: false,
      },
    ]);

    const result = await getWorkspaceDefaults(
      [],
      new Set(),
      'project-1',
      'host-1'
    );

    expect(mockedRepoList).toHaveBeenCalledWith('host-1');
    expect(mockedProjectDefaults).toHaveBeenCalledWith(
      'project-1',
      new Set(['repo-1']),
      'host-1'
    );
    expect(result).toEqual({
      preferredRepos: [{ repo_id: 'repo-1', target_branch: 'develop' }],
    });
  });

  it('keeps the selected host when falling back to a recent workspace', async () => {
    const remoteWorkspaces = [
      {
        id: 'remote-workspace-1',
        project_id: 'project-1',
        local_workspace_id: 'workspace-1',
        updated_at: '2026-07-19T00:00:00Z',
      },
    ] as Workspace[];
    mockedWorkspaceRepos.mockResolvedValue([
      { id: 'repo-2', target_branch: 'main' },
    ] as Awaited<ReturnType<typeof workspacesApi.getRepos>>);
    mockedWorkspaceGet.mockResolvedValue({} as never);

    const result = await getWorkspaceDefaults(
      remoteWorkspaces,
      new Set(['workspace-1']),
      'project-1',
      'host-2'
    );

    expect(mockedWorkspaceRepos).toHaveBeenCalledWith('workspace-1', 'host-2');
    expect(mockedWorkspaceGet).toHaveBeenCalledWith('workspace-1', 'host-2');
    expect(result).toEqual({
      preferredRepos: [{ repo_id: 'repo-2', target_branch: 'main' }],
    });
  });
});
