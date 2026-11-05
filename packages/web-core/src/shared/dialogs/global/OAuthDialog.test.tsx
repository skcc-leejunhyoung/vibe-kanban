import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UserSystemProvider } from '../../../../../local-web/src/app/providers/ConfigProvider';
import { HostUserSystemProvider } from '../../../../../local-web/src/app/providers/HostUserSystemProvider';
import { OAuthDialog } from '@/shared/dialogs/global/OAuthDialog';
import { installFakeDomReact } from '@/shared/lib/electric/electricTestKit';
import { queryClient } from '@/shared/lib/queryClient';
import { LocalAuthProvider } from '@/shared/providers/auth/LocalAuthProvider';
import { REMOTE_CLOUD_HOSTS_STATE_QUERY_KEY } from '@/shared/lib/relayHostQueryKeys';
import { tokenManager } from '@/shared/lib/auth/tokenManager';
import { configApi, oauthApi } from '@/shared/lib/api';

const env = vi.hoisted(() => ({
  host: null as string | null,
  loggedIn: false,
  click: undefined as undefined | (() => void),
  titles: [] as string[],
  status: {
    data: { logged_in: true, profile: { username: 'Synthetic user' } },
    isError: false,
  },
  modal: { visible: true, resolve: vi.fn(), remove: vi.fn() },
  cancel: vi.fn(),
  inputs: {} as Record<
    string,
    {
      onChange: (e: { target: { value: string } }) => void;
      onKeyDown?: (e: {
        key: string;
        nativeEvent: { isComposing: boolean };
        preventDefault: () => void;
      }) => void;
    }
  >,
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => env.host,
}));
vi.mock('@/shared/lib/api', () => ({
  ApiError: class extends Error {},
  configApi: { getConfig: vi.fn() },
  oauthApi: { authMethods: vi.fn(), getToken: vi.fn(), localLogin: vi.fn() },
}));
vi.mock('@/shared/hooks/useConfigPreferenceSync', () => ({
  useConfigPreferenceSync: vi.fn(),
}));
vi.mock('@/i18n/config', () => ({ updateLanguageFromConfig: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@ebay/nice-modal-react', () => ({
  create: (component: unknown) => component,
  useModal: () => env.modal,
  show: vi.fn(),
  hide: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@/shared/hooks/auth/useAuthStatus', () => ({
  useAuthStatus: () => env.status,
}));
vi.mock('@/shared/hooks/auth/useAuthMutations', () => ({
  useAuthMutations: (options: { onInitSuccess: (data: unknown) => void }) => ({
    initHandoff: {
      mutate: () => {
        env.loggedIn = true;
        options.onInitSuccess({
          handoff_id: 'synthetic-handoff',
          authorize_url: 'https://id.example.test/authorize',
        });
      },
    },
    cancelHandoff: env.cancel,
  }),
}));
vi.mock('@vibe/ui/components/KeyboardDialog', () => {
  const Pass = ({ children }: { children: unknown }) => children;
  return {
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: ({ children }: { children: string }) => {
      env.titles.push(children);
      return children;
    },
  };
});
vi.mock('@vibe/ui/components/Button', () => ({ Button: () => null }));
vi.mock('@vibe/ui/components/Input', () => ({
  Input: (props: { id: string } & (typeof env.inputs)[string]) => {
    env.inputs[props.id] = props;
    return null;
  },
}));
vi.mock('@vibe/ui/components/OAuthButtons', () => ({
  OAuthSignInButton: ({ onClick }: { onClick: () => void }) => {
    env.click = onClick;
    return null;
  },
}));
vi.mock('lucide-react', () => ({ LogIn: () => null, Loader2: () => null }));

let dom: ReturnType<typeof installFakeDomReact>;
afterEach(async () => {
  await dom.unmount();
  queryClient.clear();
  tokenManager.syncRecoveryState();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  env.host = null;
  env.loggedIn = false;
  env.titles = [];
  env.click = undefined;
  env.inputs = {};
  env.modal.resolve.mockClear();
  vi.mocked(configApi.getConfig)
    .mockReset()
    .mockImplementation(
      async (hostId) =>
        ({
          shared_api_base: 'https://central.example.test',
          login_status:
            hostId || env.loggedIn
              ? { status: 'loggedin', profile: { user_id: 'synthetic-user' } }
              : { status: 'loggedout' },
        }) as never
    );
  vi.mocked(oauthApi.authMethods).mockResolvedValue({
    local_auth_enabled: true,
    oauth_providers: ['github'],
  });
  vi.mocked(oauthApi.localLogin).mockImplementation(async () => {
    env.loggedIn = true;
    return { username: 'Synthetic user' } as never;
  });
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'synthetic-user', aud: 'access', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  vi.mocked(oauthApi.getToken)
    .mockReset()
    .mockResolvedValue({ access_token: token, expires_at: null });
  dom = installFakeDomReact();
  Object.assign(window, {
    location: { origin: 'http://localhost' },
    open: vi.fn(() => null),
  });
});

async function renderDialog() {
  await dom.render(
    <QueryClientProvider client={queryClient}>
      <UserSystemProvider>
        <LocalAuthProvider>
          <HostUserSystemProvider>
            <OAuthDialog />
          </HostUserSystemProvider>
        </LocalAuthProvider>
      </UserSystemProvider>
    </QueryClientProvider>
  );
  await vi.waitFor(() => expect(env.click).toBeTypeOf('function'));
}

it.each([null, 'synthetic-other-host'])(
  'refreshes the local login cache after OAuth on route %s',
  async (host) => {
    env.host = host;
    await renderDialog();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const shape = { pause: vi.fn(), resume: vi.fn() };
    const unregister = tokenManager.registerShape(shape);
    try {
      await act(() => env.click!());
      await vi.waitFor(() =>
        expect(env.titles).toContain('oauth.successTitle')
      );
      const local = queryClient.getQueryData<{
        login_status: { status: string };
      }>(['user-system', 'local']);
      expect(local?.login_status.status).toBe('loggedin');
      expect(oauthApi.getToken).toHaveBeenCalledOnce();
      expect(shape.resume).toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: REMOTE_CLOUD_HOSTS_STATE_QUERY_KEY,
      });
      expect(configApi.getConfig).toHaveBeenLastCalledWith(null);
    } finally {
      unregister();
    }
  }
);

it('refreshes the local account after email sign-in on another host route', async () => {
  env.host = 'synthetic-other-host';
  await renderDialog();
  await act(() => {
    env.inputs['local-auth-email'].onChange({
      target: { value: 'reader@example.test' },
    });
    env.inputs['local-auth-password'].onChange({
      target: { value: 'synthetic-password' },
    });
  });
  await act(() =>
    env.inputs['local-auth-password'].onKeyDown!({
      key: 'Enter',
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn(),
    })
  );
  await vi.waitFor(() => expect(env.titles).toContain('oauth.successTitle'));
  expect(oauthApi.localLogin).toHaveBeenCalledWith(
    'reader@example.test',
    'synthetic-password'
  );
  expect(oauthApi.getToken).toHaveBeenCalledOnce();
});

it.each(['config', 'loggedout', 'token'] as const)(
  'does not report successful login when %s recovery fails',
  async (failure) => {
    await renderDialog();
    if (failure === 'config') {
      vi.mocked(configApi.getConfig).mockRejectedValue(
        new Error('Synthetic config failure')
      );
      queryClient.setQueryDefaults(['user-system', 'local'], { retry: false });
    } else if (failure === 'loggedout') {
      vi.mocked(configApi.getConfig).mockResolvedValue({
        shared_api_base: 'https://central.example.test',
        login_status: { status: 'loggedout' },
      } as never);
    } else {
      vi.mocked(oauthApi.getToken).mockRejectedValue(
        new Error('Synthetic token outage')
      );
    }
    await act(() => env.click!());
    await vi.waitFor(() => expect(env.titles).toContain('oauth.errorTitle'));
    expect(env.titles).not.toContain('oauth.successTitle');
    expect(env.modal.resolve).not.toHaveBeenCalled();
    if (failure !== 'token') expect(oauthApi.getToken).not.toHaveBeenCalled();
  }
);
