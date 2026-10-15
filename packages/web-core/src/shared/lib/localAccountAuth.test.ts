import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { oauthApi } from './api';
import { makeLocalApiRequest, setLocalApiTransport } from './localApiTransport';
import { configureAuthRuntime } from './auth/runtime';
import { tokenManager } from './auth/tokenManager';
import { queryClient } from './queryClient';
import { setRemoteApiBase } from './remoteApi';
import { setRelayApiBase } from './relayBackendApi';
import { resetAccountHostConnections } from './accountHostConnection';
import { resetLocalSelfHost } from './accountHostTransport';

vi.mock('@/shared/providers/HostIdProvider', () => ({
  getCurrentHostId: () => 'other-account-host',
}));

const request = vi.fn(
  async (path: string) =>
    new Response(JSON.stringify({ success: true, data: { path } }))
);

beforeEach(() => {
  setLocalApiTransport({ request, openWebSocket: vi.fn() });
});
afterEach(() => {
  resetAccountHostConnections();
  resetLocalSelfHost();
  queryClient.clear();
  setRemoteApiBase(null);
  setRelayApiBase('');
  setLocalApiTransport(null);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([
  ['/api/auth/token', () => oauthApi.getToken()],
  ['/api/auth/user', () => oauthApi.getCurrentUser()],
  ['/api/auth/methods', () => oauthApi.authMethods()],
  ['/api/auth/status', () => oauthApi.status()],
  ['/api/auth/logout', () => oauthApi.logout()],
  ['/api/auth/local/login', () => oauthApi.localLogin('user@test', 'password')],
  [
    '/api/auth/handoff/init',
    () => oauthApi.handoffInit('github', 'http://localhost', true),
  ],
  [
    '/api/auth/handoff/status?handoff_id=handoff',
    () => oauthApi.handoffStatus('handoff'),
  ],
  ['/api/auth/handoff/cancel', () => oauthApi.handoffCancel('handoff')],
] as const)(
  'keeps %s on the local account while another host is selected',
  async (path, call) => {
    await call();
    expect(request.mock.calls[0][0]).toBe(path);
  }
);

it('connects to the selected account host with the local token manager and real request signing', async () => {
  setLocalApiTransport(null);
  setRemoteApiBase('https://central.test');
  setRelayApiBase('https://relay.test');
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('__APP_VERSION__', 'test');
  configureAuthRuntime({
    getToken: () => tokenManager.getToken(),
    triggerRefresh: () => tokenManager.triggerRefresh(),
    registerShape: () => () => {},
    getCurrentUser: async () => ({ user_id: 'local-user' }),
  });
  const token = `e30.${Buffer.from(JSON.stringify({ aud: 'access', sub: 'local-user', session_id: 'local-session', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  let publicKey = '';
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const json = (data: unknown) => new Response(JSON.stringify(data));
    if (url === '/api/relay-auth/client/self-host')
      return json({ data: { host_id: 'local-host' } });
    if (url === '/api/auth/token')
      return json({ success: true, data: { access_token: token } });
    if (url === 'https://central.test/v1/hosts')
      return json({
        hosts: [
          {
            id: 'other-account-host',
            name: 'Other host',
            auth_mode: 'account',
            remote_access_enabled: true,
          },
        ],
      });
    if (url.endsWith('/v1/hosts/other-account-host/connections')) {
      publicKey = JSON.parse(init!.body as string).public_key_b64;
      return json({
        data: {
          connection_id: 'connection',
          grant: 'fixture-grant',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        },
      });
    }
    if (url.endsWith('/api/relay-auth/account/session'))
      return json({
        data: {
          signing_session_id: 'connection',
          server_public_key_b64: publicKey,
        },
      });
    if (
      url ===
      'https://relay.test/v1/relay/h/other-account-host/s/connection/api/workspaces'
    ) {
      const headers = new Headers(init!.headers);
      const digest = Buffer.from(
        await webcrypto.subtle.digest('SHA-256', new Uint8Array())
      ).toString('base64');
      const message = `v1|${headers.get('x-vk-sig-ts')}|GET|/api/workspaces|connection|${headers.get('x-vk-sig-nonce')}|${digest}`;
      const key = await webcrypto.subtle.importKey(
        'raw',
        Buffer.from(publicKey, 'base64'),
        'Ed25519',
        false,
        ['verify']
      );
      expect(
        await webcrypto.subtle.verify(
          'Ed25519',
          key,
          Buffer.from(headers.get('x-vk-sig-signature')!, 'base64'),
          new TextEncoder().encode(message)
        )
      ).toBe(true);
      return json({ success: true, data: ['other-host-workspace'] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  const response = await makeLocalApiRequest('/api/workspaces');
  expect(await response.json()).toMatchObject({
    data: ['other-host-workspace'],
  });
  expect(
    fetch.mock.calls.filter(([url]) => url === '/api/auth/token')
  ).toHaveLength(1);
}, 2000);
