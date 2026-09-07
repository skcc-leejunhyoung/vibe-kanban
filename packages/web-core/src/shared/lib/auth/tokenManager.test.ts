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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('keeps the reconnect dialog and session on 503, then resumes shapes after success', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  queryClient.setQueryData(['user-system'], {
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

  expect(await tokenManager.triggerRefresh()).toBeNull();
  expect(OAuthDialog.show).not.toHaveBeenCalled();
  expect(queryClient.getQueryData(['user-system'])).toMatchObject({
    login_status: { status: 'loggedin' },
    remote_auth_degraded: 'remote_auth_unavailable',
  });
  expect(queryClient.getQueryState(['user-system'])?.isInvalidated).toBe(false);
  expect(shape.pause).toHaveBeenCalledOnce();
  expect(shape.resume).not.toHaveBeenCalled();

  expect(await tokenManager.triggerRefresh()).toBe('renewed-token');
  expect(shape.resume).toHaveBeenCalledOnce();
  expect(queryClient.getQueryData(['user-system'])).toMatchObject({
    remote_auth_degraded: null,
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(request).toHaveBeenCalledTimes(2);
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
    queryClient.setQueryData(['user-system'], {
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
