import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  send: vi.fn(),
  account: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('@/shared/lib/accountHostConnection', () => ({
  resolveAccountHostConnection: mocks.resolve,
  accountHost: mocks.account,
  watchAccountConnectionCleanup: mocks.cleanup,
}));
vi.mock('@/shared/lib/relay/http', () => ({
  sendRelayHostRequest: mocks.send,
}));
vi.mock('@/shared/lib/relay/signing', () => ({
  normalizeRequestBody: async (body: BodyInit) => ({
    body,
    bodyBytes: new Uint8Array(),
    contentType: null,
  }),
  buildRelaySignature: vi.fn(),
  appendSignatureToPath: vi.fn(),
}));
vi.mock('@/shared/lib/relay/ws', () => ({
  createRelaySignedWebSocket: vi.fn(),
  createRelayWsSigningContext: vi.fn(),
}));
import {
  requestAccountHost,
  resolveLocalAccountTarget,
  resetLocalSelfHost,
} from './accountHostTransport';
beforeEach(() => {
  mocks.resolve.mockResolvedValue({ sessionId: 'one' });
  mocks.cleanup.mockReturnValue(vi.fn());
  mocks.account.mockResolvedValue({ auth_mode: 'account' });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  resetLocalSelfHost();
});
describe('account transport', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'never replays a %s after an ambiguous authentication failure',
    async (method) => {
      mocks.send.mockResolvedValue(
        new Response('unknown outcome', { status: 401 })
      );
      const response = await requestAccountHost('host', '/api/workspaces', {
        method,
        body: 'command',
      });
      expect(response.status).toBe(401);
      expect(mocks.send).toHaveBeenCalledOnce();
      expect(mocks.resolve).toHaveBeenCalledOnce();
    }
  );
  it('surfaces an unknown write result and does not resend after a dropped response', async () => {
    mocks.send.mockRejectedValueOnce(new TypeError('network dropped'));
    await expect(
      requestAccountHost('host', '/api/workspaces', {
        method: 'POST',
        body: 'command',
      })
    ).rejects.toMatchObject({ code: 'HOST_WRITE_OUTCOME_UNKNOWN' });
    expect(mocks.send).toHaveBeenCalledOnce();
  });
  it('retries only a safe read after fresh approval', async () => {
    mocks.send
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response('ok'));
    expect(
      await (await requestAccountHost('host', '/api/workspaces')).text()
    ).toBe('ok');
    expect(mocks.resolve).toHaveBeenLastCalledWith('host', true);
  });
  it('keeps the local self alias independent of central availability and uses direct account transport for another host', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: { host_id: 'self' } }))
        )
    );
    expect(
      await resolveLocalAccountTarget('/api/host/self/workspaces')
    ).toBeNull();
    expect(mocks.account).not.toHaveBeenCalled();
    expect(
      await resolveLocalAccountTarget('/api/host/other/workspaces')
    ).toEqual({ host: 'other', path: '/api/workspaces' });
  });
});
