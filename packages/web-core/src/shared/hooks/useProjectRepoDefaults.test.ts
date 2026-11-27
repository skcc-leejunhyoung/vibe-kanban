import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, scratchApi } from '@/shared/lib/api';
import { getProjectRepoDefaults } from './useProjectRepoDefaults';

vi.mock('@/shared/lib/api', async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import('@/shared/lib/api')>())
    .ApiError,
  scratchApi: { get: vi.fn() },
}));

describe('getProjectRepoDefaults', () => {
  beforeEach(() => {
    vi.mocked(scratchApi.get).mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('reads a project without saved defaults (404) as none', async () => {
    vi.mocked(scratchApi.get).mockRejectedValue(
      new ApiError('Scratch not found.', 404)
    );

    await expect(getProjectRepoDefaults('project-1')).resolves.toBeNull();
  });

  it('throws on other failures so a failed read is not saved over', async () => {
    vi.mocked(scratchApi.get).mockRejectedValue(new ApiError('boom', 500));

    await expect(getProjectRepoDefaults('project-1')).rejects.toThrow('boom');
  });
});
