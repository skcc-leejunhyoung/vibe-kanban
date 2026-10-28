import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactInteraction } from 'shared/types';

const request = vi.hoisted(() => vi.fn());
vi.mock('./localApiTransport', () => ({ makeLocalApiRequest: request }));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  getCurrentHostId: () => 'unrelated-host',
}));
import { artifactsApi } from './api';

const interaction = {
  reference: {
    request_id: 'request',
    session_id: 'session',
    execution_id: 'process',
  },
  workspace_id: 'workspace',
  artifact_id: 'form',
  artifact_hash: 'html',
  version: 'bundle',
  owner_host: 'owner-host',
  owner_id: 'owner',
  delivery: 'follow_up',
  state: 'input_required',
  schema: { type: 'object', properties: {}, required: [] },
  created_at: '',
  expires_at: '',
  result_process_id: null,
  error: null,
} as ArtifactInteraction;

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: interaction }))
  );
});

describe('artifact input host routing', () => {
  it('requires the fixed bundle version when loading a registered form', async () => {
    await artifactsApi.bundle(
      'process',
      'workspace',
      'session',
      'form',
      'paired-host',
      undefined,
      'fixed-bundle'
    );
    const [url, options] = request.mock.calls[0];
    expect(
      new URL(url, 'https://test.invalid').searchParams.get('version')
    ).toBe('fixed-bundle');
    expect(options.hostId).toBe('paired-host');
    expect(options.hostScope).toBe('explicit');
  });
  it.each([null, 'paired-host'])(
    'pins every response to the artifact host %s',
    async (host) => {
      await artifactsApi.respond(
        interaction,
        { action: 'submit', data: { choice: 'run' } },
        host
      );
      const [url, options] = request.mock.calls[0];
      expect(url).toContain(
        '/execution-processes/process/artifacts/interactions/request/respond'
      );
      expect(url).toContain('workspace_id=workspace&session_id=session');
      expect(options.hostScope).toBe('explicit');
      expect(options.hostId).toBe(host);
      expect(options.relayHostId).toBe(host);
      expect(JSON.parse(options.body)).toEqual({
        artifact_id: 'form',
        version: 'bundle',
        owner_host: 'owner-host',
        response: { action: 'submit', data: { choice: 'run' } },
      });
    }
  );
  it('uses the same route for cancellation and never retries a lost response', async () => {
    request.mockRejectedValue(new Error('Disconnected'));
    await expect(
      artifactsApi.respond(interaction, { action: 'cancel' }, 'paired-host')
    ).rejects.toThrow('Disconnected');
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0][1].body).response).toEqual({
      action: 'cancel',
    });
  });
});
