import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostAccountError } from '@/shared/lib/hostAccountApi';
import { resetLocalSelfHost } from '@/shared/lib/accountHostTransport';
import {
  accountDeviceLabel,
  localHostRegistration,
  registerLocalAccountHost,
  useAccountSettingsAction,
} from './AccountSettingsShared';

const auth = vi.hoisted(() => ({ userId: 'alice' }));
vi.mock('@/shared/hooks/auth/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/shared/dialogs/global/OAuthDialog', () => ({
  OAuthDialog: { show: vi.fn() },
}));
vi.mock('@/shared/lib/accountHostTransport', () => ({
  resetLocalSelfHost: vi.fn(),
}));

let root: Root,
  client: QueryClient,
  action: ReturnType<typeof useAccountSettingsAction>;
function Probe() {
  action = useAccountSettingsAction();
  return null;
}
function tree(key = 'one') {
  return (
    <QueryClientProvider client={client}>
      <Probe key={key} />
    </QueryClientProvider>
  );
}
beforeEach(async () => {
  auth.userId = 'alice';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), { nodeType: 9, activeElement: null })
  );
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} })
  );
  const container = Object.assign(new EventTarget(), {
    nodeType: 1,
    tagName: 'DIV',
    ownerDocument: document,
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container as unknown as HTMLElement);
  await act(() => root.render(tree()));
});
afterEach(async () => {
  await act(() => root.unmount());
  client.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('settings mutations', () => {
  it('coalesces repeated clicks without replaying a mutation', async () => {
    let release!: () => void;
    const mutation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const done = vi.fn();
    let first!: Promise<boolean>;
    await act(async () => {
      first = action.run(mutation, 'saved', done);
      expect(await action.run(mutation, 'twice', done)).toBe(false);
    });
    expect(mutation).toHaveBeenCalledOnce();
    await act(async () => {
      release();
      expect(await first).toBe(true);
    });
    expect(done).toHaveBeenCalledOnce();
    expect(action.status).toBe('saved');
  });
  it('refreshes stale policy on version conflict without retrying the write', async () => {
    client.setQueryData(['host-policy', 'alice', 'host'], { version: 1 });
    const failure = new HostAccountError(
      409,
      'GRANT_VERSION_CONFLICT',
      'changed'
    );
    const mutation = vi.fn().mockRejectedValue(failure);
    const done = vi.fn();
    await act(async () => {
      expect(await action.run(mutation, 'saved', done)).toBe(false);
    });
    expect(mutation).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    expect(
      client.getQueryState(['host-policy', 'alice', 'host'])?.isInvalidated
    ).toBe(true);
    expect(action.error).toBe(failure);
    expect(action.busy).toBe(false);
  });
  it('does not close or log out the new account when an old request completes', async () => {
    let release!: () => void;
    const done = vi.fn();
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = action.run(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        'old',
        done
      );
    });
    auth.userId = 'bob';
    await act(() => root.render(tree('bob')));
    await act(async () => {
      release();
      expect(await pending).toBe(false);
    });
    expect(done).not.toHaveBeenCalled();
    expect(action.status).toBe('');
  });
  it('leaves recent-login failures explicit and never automatically resubmits', async () => {
    const mutation = vi
      .fn()
      .mockRejectedValue(
        new HostAccountError(
          403,
          'REAUTHENTICATION_REQUIRED',
          'recent login required'
        )
      );
    await act(async () => {
      await action.run(mutation, 'saved');
    });
    expect(mutation).toHaveBeenCalledOnce();
    expect(action.error).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    expect(action.status).toBe('');
  });
  it('stops follow-up work when the account changes while success reconciliation is pending', async () => {
    let release!: () => void;
    const nextWrite = vi.fn();
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = action.run(
        async () => 'registered',
        '',
        async (_, isCurrent) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          if (isCurrent()) nextWrite();
        }
      );
    });
    auth.userId = 'bob';
    await act(() => root.render(tree('bob')));
    await act(async () => {
      release();
      expect(await pending).toBe(false);
    });
    expect(nextWrite).not.toHaveBeenCalled();
  });
});

describe('registration retry and ownership', () => {
  function localStatus(mode: string | null, owner = 'alice') {
    return {
      account_mode: true,
      registration: mode
        ? {
            host_id: 'host',
            owner_user_id: owner,
            generation: 3,
            transition_request_id: 'persisted-request',
            auth_mode: mode,
          }
        : null,
    };
  }
  function respond(status: ReturnType<typeof localStatus>) {
    return new Response(JSON.stringify({ success: true, data: status }));
  }
  it('registers an installation with no completed registration', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(localStatus(null)))
      .mockResolvedValueOnce(respond(localStatus('account')));
    vi.stubGlobal('fetch', fetch);
    await registerLocalAccountHost('alice', false, () => true);
    expect(fetch.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ['/api/relay-auth/account/registration', 'GET'],
      ['/api/relay-auth/account/registration', 'POST'],
    ]);
  });
  it('explicitly replaces the old credential when registering a removed account host again', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(localStatus('account')))
      .mockResolvedValueOnce(respond(localStatus('account')));
    vi.stubGlobal('fetch', fetch);
    await registerLocalAccountHost('alice', true, () => true);
    expect(fetch.mock.calls[1]).toEqual([
      '/api/relay-auth/account/registration?replace=true',
      { method: 'POST' },
    ]);
  });
  it('resumes a persisted transition instead of rotating a second time after partial failure', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(localStatus('migrating')))
      .mockResolvedValueOnce(respond(localStatus('account')));
    vi.stubGlobal('fetch', fetch);
    await registerLocalAccountHost('alice', true, () => true);
    expect(fetch.mock.calls[1]).toEqual([
      '/api/relay-auth/account/registration',
      { method: 'POST' },
    ]);
  });
  it('keeps a completed registration when retrying a failed name save', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(localStatus('account')));
    vi.stubGlobal('fetch', fetch);
    const result = await registerLocalAccountHost('alice', false, () => true);
    expect(result.registration?.host_id).toBe('host');
    expect(fetch).toHaveBeenCalledOnce();
    expect(resetLocalSelfHost).not.toHaveBeenCalled();
  });
  it('rejects a new owner discovered by the preflight without changing registration', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(localStatus('account', 'bob')));
    vi.stubGlobal('fetch', fetch);
    await expect(
      registerLocalAccountHost('alice', true, () => true)
    ).rejects.toMatchObject({ code: 'HOST_NOT_FOUND' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('sends no follow-up write if the initiating view is no longer current', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(localStatus('account')));
    vi.stubGlobal('fetch', fetch);
    await expect(
      registerLocalAccountHost('alice', true, () => false)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not replay a registration whose result was lost', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(localStatus('account')))
      .mockRejectedValueOnce(new Error('response lost'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      registerLocalAccountHost('alice', true, () => true)
    ).rejects.toThrow('response lost');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('local registration and device labels', () => {
  it('uses the direct local registration endpoint and keeps recovery explicit', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { account_mode: true, registration: null },
        })
      )
    );
    vi.stubGlobal('fetch', fetch);
    await localHostRegistration('POST', true);
    expect(fetch).toHaveBeenCalledWith(
      '/api/relay-auth/account/registration?replace=true',
      { method: 'POST' }
    );
    expect(resetLocalSelfHost).toHaveBeenCalledOnce();
  });
  it('does not clear host identity when registration fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ success: false, message: 'fresh login required' }),
            { status: 403 }
          )
        )
    );
    await expect(localHostRegistration('POST')).rejects.toMatchObject({
      code: 'REAUTHENTICATION_REQUIRED',
    });
    expect(resetLocalSelfHost).not.toHaveBeenCalled();
  });
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0',
      'Edge · Windows',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1',
      'Safari · iPhone',
    ],
    ['My named browser', 'My named browser'],
    [null, null],
  ])(
    'presents device context instead of the raw agent: %s',
    (label, expected) => {
      expect(accountDeviceLabel(label)).toBe(expected);
    }
  );
});
