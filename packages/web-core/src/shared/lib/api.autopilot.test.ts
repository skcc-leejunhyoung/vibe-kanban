import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { workspacesApi } from './api';

vi.mock('@/shared/lib/localApiTransport', () => ({
  makeLocalApiRequest: vi.fn(),
}));

const answer = (response: Response) =>
  vi.mocked(makeLocalApiRequest).mockResolvedValueOnce(response);

beforeEach(() => {
  vi.mocked(makeLocalApiRequest).mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Autopilot lookup', () => {
  it('reads the host’s own 404 as "no Autopilot"', async () => {
    answer(
      new Response(
        JSON.stringify({ success: false, message: 'Workspace not found' }),
        { status: 404 }
      )
    );
    await expect(workspacesApi.getAutopilot('host-b')).resolves.toBeNull();
  });

  it('fails when the 404 comes from a relay that cannot reach the host', async () => {
    // Not "none": the host may have its Autopilot, and the dialog would offer
    // to start a second one.
    answer(new Response('No active relay', { status: 404 }));
    await expect(workspacesApi.getAutopilot('host-b')).rejects.toThrow();
  });

  it('returns the Autopilot the host has', async () => {
    const autopilot = { workspace: { id: 'synthetic' }, session: null };
    answer(new Response(JSON.stringify({ success: true, data: autopilot })));
    await expect(workspacesApi.getAutopilot('host-b')).resolves.toEqual(
      autopilot
    );
  });
});
