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
