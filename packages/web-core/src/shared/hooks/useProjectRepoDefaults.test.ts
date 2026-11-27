import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { getProjectRepoDefaults } from './useProjectRepoDefaults';

vi.mock('@/shared/lib/localApiTransport', () => ({
  makeLocalApiRequest: vi.fn(),
}));

const answer = (response: Response) =>
  vi.mocked(makeLocalApiRequest).mockResolvedValueOnce(response);

beforeEach(() => {
  vi.mocked(makeLocalApiRequest).mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('getProjectRepoDefaults', () => {
  it('reads the host’s own 404 as "nothing saved yet"', async () => {
    answer(
      new Response(
        JSON.stringify({ success: false, message: 'Scratch not found.' }),
        { status: 404 }
      )
    );
    await expect(getProjectRepoDefaults('project-1')).resolves.toBeNull();
  });

  it('fails when the 404 comes from a relay that cannot reach the host', async () => {
    // Read as "none", the next edit would save over the host's real list.
    answer(new Response('No active relay', { status: 404 }));
    await expect(getProjectRepoDefaults('project-1')).rejects.toThrow();
  });

  it('fails on other errors', async () => {
    answer(
      new Response(JSON.stringify({ success: false, message: 'boom' }), {
        status: 500,
      })
    );
    await expect(getProjectRepoDefaults('project-1')).rejects.toThrow('boom');
  });

  it('returns the saved repos', async () => {
    const repos = [{ repo_id: 'repo-1', target_branch: 'main' }];
    answer(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'project-1',
            payload: { type: 'PROJECT_REPO_DEFAULTS', data: { repos } },
          },
        })
      )
    );
    await expect(getProjectRepoDefaults('project-1')).resolves.toEqual(repos);
  });
});
