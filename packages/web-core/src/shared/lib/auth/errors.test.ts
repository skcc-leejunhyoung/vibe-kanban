import { afterEach, expect, it, vi } from 'vitest';
import { AuthError, getAuthErrorKind } from './errors';
import { configureAuthRuntime } from './runtime';
import { makeRequest, setRemoteApiBase } from '../remoteApi';

afterEach(() => {
  vi.unstubAllGlobals();
  setRemoteApiBase(null);
});
it.each([
  [new AuthError('required', 'missing credentials'), 'required'],
  [{ statusCode: 401 }, 'required'],
  [{ status: 403 }, 'forbidden'],
  [{ statusCode: 503 }, 'unavailable'],
  [new TypeError('network unavailable'), 'unavailable'],
  [new AuthError('unavailable', 'token not ready'), 'unavailable'],
] as const)(
  'classifies auth failures without parsing text: %s',
  (error, kind) => {
    expect(getAuthErrorKind(error)).toBe(kind);
  }
);

it.each([false, true])(
  'keeps a transient failure during token lookup or refresh (refresh=%s)',
  async (refresh) => {
    const error = Object.assign(new Error('synthetic unavailable'), {
      statusCode: 503,
    });
    configureAuthRuntime({
      getToken: async () => {
        if (!refresh) throw error;
        return 'synthetic-token';
      },
      triggerRefresh: async () => {
        throw error;
      },
      getCurrentUser: async () => ({ user_id: 'test-user' }),
      registerShape: () => () => {},
    });
    vi.stubGlobal('__APP_VERSION__', 'test');
    const fetch = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    setRemoteApiBase('https://central.test');
    await expect(makeRequest('/v1/hosts')).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(refresh ? 1 : 0);
  }
);
