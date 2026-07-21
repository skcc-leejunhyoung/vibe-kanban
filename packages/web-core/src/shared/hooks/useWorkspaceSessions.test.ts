import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/lib/api', () => ({
  sessionsApi: {
    getByWorkspace: vi.fn(),
  },
}));

import { sessionsApi } from '@/shared/lib/api';
import { workspaceSessionsQuery } from './useWorkspaceSessions';

describe('workspaceSessionsQuery', () => {
  beforeEach(() => {
    vi.mocked(sessionsApi.getByWorkspace).mockReset();
  });

  it('fetches from the workspace owner host during cross-host prefetch', async () => {
    vi.mocked(sessionsApi.getByWorkspace).mockResolvedValue([]);

    await workspaceSessionsQuery('workspace-1', 'host-2').queryFn();

    expect(sessionsApi.getByWorkspace).toHaveBeenCalledWith(
      'workspace-1',
      'host-2'
    );
  });
});
