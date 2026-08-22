import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoApi } from '@/shared/lib/api';
import { resolveBootstrapRepos } from './createModeBootstrap';

vi.mock('@/shared/lib/api', () => ({
  repoApi: { getById: vi.fn() },
}));

describe('resolveBootstrapRepos', () => {
  beforeEach(() => {
    vi.mocked(repoApi.getById).mockReset();
  });

  it('loads restored repositories from the selected host', async () => {
    vi.mocked(repoApi.getById).mockResolvedValue({
      id: 'repo-1',
      name: 'repo',
    } as never);

    await resolveBootstrapRepos(
      [{ repo_id: 'repo-1', target_branch: 'main' }],
      'host-1'
    );

    expect(repoApi.getById).toHaveBeenCalledWith('repo-1', 'host-1');
  });
});
