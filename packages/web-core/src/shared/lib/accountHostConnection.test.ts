import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
const mocks = vi.hoisted(() => ({ token: '', list: vi.fn(), open: vi.fn() }));
vi.mock('@/shared/lib/auth/runtime', () => ({
  getAuthRuntime: () => ({ getToken: async () => mocks.token }),
}));
vi.mock('@/shared/lib/remoteApi', () => ({
  getRemoteApiUrl: () => 'https://central.test',
  listRelayHosts: mocks.list,
  makeRequest: vi.fn(),
}));
vi.mock('@/shared/lib/relayBackendApi', () => ({
  buildRemoteSessionBaseUrl: (h: string, s: string) =>
    `https://relay.test/${h}/${s}`,
}));
vi.mock('@/shared/lib/hostAccountApi', async (original) => ({
  ...(await original<object>()),
  hostAccountApi: { open: mocks.open },
}));
import {
  resetAccountHostConnections,
  resolveAccountHostConnection,
  watchAccountConnectionCleanup,
} from './accountHostConnection';
import { HostAccountError } from './hostAccountApi';
function token(user: string) {
  return `header.${btoa(JSON.stringify({ sub: user, session_id: `session-${user}` }))}.sig`;
}
function approval(id = 'connection') {
  return {
    connection_id: id,
    grant: 'central-signed-grant',
    expires_at: new Date(Date.now() + 300_000).toISOString(),
  };
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  mocks.token = token('alice');
  mocks.list.mockResolvedValue([
    {
      id: 'host',
      name: 'Host',
      auth_mode: 'account',
      remote_access_enabled: true,
    },
  ]);
  mocks.open.mockResolvedValue(approval());
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            signing_session_id: 'connection',
            server_public_key_b64: 'public',
          },
        })
      )
    )
  );
});
afterEach(() => {
  resetAccountHostConnections();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('account host connections', () => {
  it('explains an unsupported browser without creating a connection', async () => {
    vi.stubGlobal('crypto', { subtle: undefined });
    await expect(resolveAccountHostConnection('host')).rejects.toMatchObject({
      code: 'HOST_BROWSER_UPDATE_REQUIRED',
    });
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('opens without any pairing store and shares one nonextractable ephemeral key across simultaneous requests', async () => {
    const [one, two] = await Promise.all([
      resolveAccountHostConnection('host'),
      resolveAccountHostConnection('host'),
    ]);
    expect(one).toBe(two);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(one.pairedHost.account_ephemeral).toBe(true);
    expect(one.pairedHost.private_key?.extractable).toBe(false);
    expect(mocks.open.mock.calls[0][1].connection_id).toBeNull();
    await expect(
      webcrypto.subtle.exportKey('pkcs8', one.pairedHost.private_key!)
    ).rejects.toThrow();
  });
  it('rejects a late approval after switching accounts and closes old streams', async () => {
    let release!: (value: ReturnType<typeof approval>) => void;
    mocks.open.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const pending = resolveAccountHostConnection('host');
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
    const close = vi.fn();
    watchAccountConnectionCleanup(close);
    mocks.token = token('bob');
    await resolveAccountHostConnection('host');
    release(approval('old'));
    await expect(pending).rejects.toThrow('Account changed');
    expect(close).toHaveBeenCalledOnce();
  });
  it('requests fresh authorization after connection termination without reviving its old ID', async () => {
    await resolveAccountHostConnection('host');
    mocks.open
      .mockRejectedValueOnce(
        new HostAccountError(401, 'HOST_CONNECTION_EXPIRED', 'expired')
      )
      .mockResolvedValueOnce(approval('new'));
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { signing_session_id: 'new', server_public_key_b64: 'public' },
        })
      )
    );
    const next = await resolveAccountHostConnection('host', true);
    expect(next.sessionId).toBe('new');
    expect(mocks.open.mock.calls.at(-2)?.[1].connection_id).toBe('connection');
    expect(mocks.open.mock.calls.at(-1)?.[1].connection_id).toBeNull();
  });
  it('never falls back to another host credential for a missing or migrating account host', async () => {
    mocks.list.mockResolvedValueOnce([]);
    await expect(resolveAccountHostConnection('host')).rejects.toMatchObject({
      code: 'HOST_ACCESS_REVOKED',
    });
    mocks.list.mockResolvedValueOnce([{ id: 'host', auth_mode: 'migrating' }]);
    await expect(resolveAccountHostConnection('host')).rejects.toMatchObject({
      code: 'HOST_TRANSITION_IN_PROGRESS',
    });
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('propagates a control-plane outage without deleting the login or treating it as an empty host list', async () => {
    mocks.list.mockRejectedValueOnce(new Error('network down'));
    await expect(resolveAccountHostConnection('host')).rejects.toThrow(
      'network down'
    );
    expect(mocks.token).toBe(token('alice'));
    expect(mocks.open).not.toHaveBeenCalled();
    await expect(resolveAccountHostConnection('host')).resolves.toHaveProperty(
      'sessionId',
      'connection'
    );
  });
});
