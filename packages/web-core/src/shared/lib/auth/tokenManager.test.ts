import { afterEach, expect, it, vi } from 'vitest';
import { OAuthDialog } from '@/shared/dialogs/global/OAuthDialog';
import { setLocalApiTransport } from '@/shared/lib/localApiTransport';
import { queryClient } from '@/shared/lib/queryClient';
import { tokenManager } from './tokenManager';

vi.mock('@/shared/dialogs/global/OAuthDialog', () => ({
  OAuthDialog: { show: vi.fn() },
}));

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  queryClient.clear();
  tokenManager.syncRecoveryState();
  setLocalApiTransport(null);
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('keeps the reconnect dialog and session on 503, then resumes shapes after success', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  queryClient.setQueryData(['user-system', 'local'], {
    login_status: { status: 'loggedin' },
  });
  const shape = { pause: vi.fn(), resume: vi.fn() };
  unregister = tokenManager.registerShape(shape);
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: 'OAuth reconnect is in progress' }),
        { status: 503 }
      )
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: { access_token: 'renewed-token', expires_at: null },
        })
      )
    );
  setLocalApiTransport({ request, openWebSocket: vi.fn() });

  await expect(tokenManager.triggerRefresh()).rejects.toMatchObject({
    statusCode: 503,
  });
  expect(OAuthDialog.show).not.toHaveBeenCalled();
  expect(queryClient.getQueryData(['user-system', 'local'])).toMatchObject({
    login_status: { status: 'loggedin' },
    remote_auth_degraded: 'remote_auth_unavailable',
  });
  expect(
    queryClient.getQueryState(['user-system', 'local'])?.isInvalidated
  ).toBe(false);
  expect(shape.pause).toHaveBeenCalledOnce();
  expect(shape.resume).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(2);
  expect(shape.resume).toHaveBeenCalledOnce();
  expect(queryClient.getQueryData(['user-system', 'local'])).toMatchObject({
    remote_auth_degraded: null,
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(request).toHaveBeenCalledTimes(2);
});

it('uses the local login state and can refresh after logging back in', async () => {
  queryClient.setQueryData(['user-system', 'local'], {
    login_status: { status: 'loggedout' },
  });
  queryClient.setQueryData(['user-system', 'remote-route', 'host-a'], {
    login_status: { status: 'loggedin' },
  });
  const request = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: { access_token: 'renewed-token', expires_at: null },
      })
    )
  );
  setLocalApiTransport({ request, openWebSocket: vi.fn() });
  expect(await tokenManager.getToken()).toBeNull();
  expect(await tokenManager.triggerRefresh()).toBeNull();
  expect(request).not.toHaveBeenCalled();

  queryClient.setQueryData(['user-system', 'local'], {
    login_status: { status: 'loggedin' },
  });
  expect(await tokenManager.triggerRefresh()).toBe('renewed-token');
  expect(request).toHaveBeenCalledOnce();
  expect(
    queryClient.getQueryData(['user-system', 'remote-route', 'host-a'])
  ).toEqual({ login_status: { status: 'loggedin' } });
});

it('prompts for a real expired session without scheduling a recovery loop', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  queryClient.setQueryData(['user-system', 'local'], {
    login_status: { status: 'loggedin' },
  });
  const request = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ message: 'Session expired' }), {
        status: 401,
      })
  );
  setLocalApiTransport({ request, openWebSocket: vi.fn() });
  await expect(tokenManager.getToken()).rejects.toMatchObject({
    statusCode: 401,
  });
  expect(OAuthDialog.show).toHaveBeenCalledOnce();
  expect(
    queryClient.getQueryState(['user-system', 'local'])?.isInvalidated
  ).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(request).toHaveBeenCalledOnce();
});

it('backs off after repeated recovery failures without an unhandled rejection', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  queryClient.setQueryData(['user-system', 'local'], {
    login_status: { status: 'loggedin' },
  });
  const request = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ message: 'Unavailable' }), {
        status: 503,
      })
  );
  setLocalApiTransport({ request, openWebSocket: vi.fn() });
  await expect(tokenManager.getToken()).rejects.toMatchObject({
    statusCode: 503,
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledTimes(3);
  expect(OAuthDialog.show).not.toHaveBeenCalled();
});

it.each([
  ['user-b', false],
  ['user-b', true],
  ['user-a', false],
  ['user-a', true],
] as const)(
  'checks local retry account %s with pending refresh=%s',
  async (nextUser, pendingRefresh) => {
    const accessToken = (sub: string, nonce: string) =>
      'e30.' +
      Buffer.from(
        JSON.stringify({
          aud: 'access',
          sub,
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      ).toString('base64url') +
      '.signature';
    const rejected = accessToken('user-a', 'rejected');
    const current = accessToken(nextUser, 'renewed');
    queryClient.setQueryData(['user-system', 'local'], {
      login_status: { status: 'loggedin' },
    });
    let release!: (response: Response) => void;
    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    setLocalApiTransport({ request, openWebSocket: vi.fn() });
    const refreshing = pendingRefresh
      ? tokenManager.triggerRefresh()
      : undefined;
    const retry = tokenManager
      .triggerRefresh(rejected)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    release(
      new Response(
        JSON.stringify({
          success: true,
          data: { access_token: current, expires_at: null },
        })
      )
    );
    if (refreshing) await expect(refreshing).resolves.toBe(current);
    if (nextUser === 'user-a') {
      expect(await retry).toBe(current);
    } else {
      expect(await retry).toBeInstanceOf(Error);
      expect(String(await retry)).toContain('Session changed during refresh');
    }
    expect(queryClient.getQueryData(['auth', 'token'])).toMatchObject({
      access_token: current,
    });
    expect(OAuthDialog.show).not.toHaveBeenCalled();
  }
);
