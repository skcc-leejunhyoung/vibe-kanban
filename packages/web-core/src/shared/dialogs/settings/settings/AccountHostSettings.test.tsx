import { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayHost } from 'shared/remote-types';
import type { AccountHostStatus } from 'shared/types';
import { findDialogPrimaryAction } from '@vibe/ui/lib/dialog-keyboard';
import en from '@/i18n/locales/en/settings.json';
import { AccountHostSettings } from './AccountHostSettings';
import { AccountSettingsSection } from './AccountSettingsSection';
import {
  LocalAccountHostSettings,
  RegisterComputerGuide,
} from './LocalAccountHostSettings';
import { AccountHostDetailsDialog } from './AccountHostDetailsDialog';

const mock = vi.hoisted(() => ({
  user: 'alice' as string | null,
  runtime: 'local' as 'local' | 'remote',
  fetchHosts: vi.fn(),
  fetchSessions: vi.fn(),
}));
vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({
    userId: mock.user,
    isSignedIn: Boolean(mock.user),
    isLoaded: true,
  }),
}));
vi.mock('@/shared/hooks/useAppRuntime', () => ({
  useAppRuntime: () => mock.runtime,
}));
vi.mock('@/shared/hooks/useUserSystem', () => ({
  useUserSystem: () => ({
    config: { host_nickname: 'This Mac' },
    loginStatus: {
      status: 'loggedin',
      profile: { username: 'Alice', email: 'alice@example.com' },
    },
  }),
}));
vi.mock('@/shared/lib/remoteApi', () => ({
  listRelayHosts: mock.fetchHosts,
  updateRelayHost: vi.fn(),
  getRemoteApiUrl: () => 'https://central.test',
}));
vi.mock('@/shared/lib/hostAccountApi', async (original) => ({
  ...(await original<object>()),
  hostAccountApi: {
    sessions: mock.fetchSessions,
    policy: vi.fn(),
    connections: vi.fn(),
    audit: vi.fn(),
    profile: vi.fn(),
  },
}));
vi.mock('@/shared/dialogs/global/OAuthDialog', () => ({
  OAuthDialog: { show: vi.fn() },
}));
vi.mock('@/shared/lib/accountHostTransport', () => ({
  resetLocalSelfHost: vi.fn(),
}));
vi.mock('@/shared/lib/accountHostConnection', () => ({
  resetAccountHostConnections: vi.fn(),
}));
vi.mock('@vibe/ui/components/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <footer>{children}</footer>
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (at, part) =>
            at && typeof at === 'object'
              ? (at as Record<string, unknown>)[part]
              : undefined,
          en
        );
      return String(value ?? values.defaultValue ?? key).replace(
        /{{(\w+)}}/g,
        (_, name) => String(values[name] ?? '')
      );
    },
  }),
}));

function host(
  id: string,
  role = 'owner',
  extra: Partial<RelayHost> = {}
): RelayHost {
  return {
    id,
    name: id,
    owner_user_id: role === 'owner' ? 'alice' : 'owner',
    access_role: role,
    machine_id: id,
    auth_mode: 'account',
    auth_generation: 3,
    remote_access_enabled: true,
    status: 'online',
    last_seen_at: null,
    agent_version: '1',
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-16T00:00:00Z',
    capabilities: [],
    ...extra,
  };
}
let client: QueryClient;
function render(node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
}
const registration: AccountHostStatus = {
  account_mode: true,
  relay_started: true,
  api_base: 'https://central.test',
  registration: {
    host_id: 'self',
    owner_user_id: 'alice',
    generation: 3,
    transition_request_id: 'transition',
    auth_mode: 'account',
  },
};
beforeEach(() => {
  mock.user = 'alice';
  mock.runtime = 'local';
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    ['account-hosts', 'alice'],
    [host('self'), host('Shared GPU', 'member')]
  );
  client.setQueryData(['account-host-registration', 'alice'], registration);
});
afterEach(() => {
  client.clear();
  vi.clearAllMocks();
});

describe('remote access settings information architecture', () => {
  it('shows computer status and management without connection links or login-device controls', () => {
    const html = render(<AccountHostSettings legacy={null} />);
    expect(html).toContain('My computers');
    expect(html).toContain('Shared with me');
    expect(html).toContain('This computer');
    expect(html).toContain('Manage');
    expect(html).toContain('My connections');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('Signed-in devices');
    expect(html).not.toContain('Sign out all');
  });
  it('keeps the remote browser distinct from the registered computer', () => {
    mock.runtime = 'remote';
    const html = render(<AccountHostSettings legacy={null} />);
    expect(html).toContain('How to add a computer');
    expect(html).not.toContain('This computer');
    const guide = render(<RegisterComputerGuide />);
    expect(guide).toContain('not from this browser');
    expect(guide).not.toContain('register-account-host');
  });
  it('does not show the previous account computer cache after an account change', () => {
    mock.user = 'bob';
    const html = render(<AccountHostSettings legacy={null} />);
    expect(html).not.toContain('Shared GPU');
    expect(html).not.toContain('>self<');
  });
  it('distinguishes a failed refresh from an empty allowlist and keeps last known hosts', () => {
    client
      .getQueryCache()
      .find({ queryKey: ['account-hosts', 'alice'] })!
      .setState({
        status: 'error',
        error: new Error('network'),
        fetchStatus: 'idle',
      });
    const html = render(<AccountHostSettings legacy={null} />);
    expect(html).toContain('Could not refresh');
    expect(html).toContain('last known list');
    expect(html).toContain('Shared GPU');
    expect(html).not.toContain('No computers yet');
  });
  it('does not expose cached computer details to a signed-out browser', () => {
    mock.user = null;
    const html = render(
      <AccountHostSettings legacy={null} initialHostId="self" />
    );
    expect(html).toContain('Start with your account');
    expect(html).not.toContain('Shared GPU');
    expect(html).not.toContain('Computer management');
  });
  it('shows registration as waiting until the actual relay is online', () => {
    const state = {
      data: registration,
      isSuccess: true,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    };
    const html = render(
      <LocalAccountHostSettings
        state={state as never}
        hostsReady={false}
        registrationOpen={false}
        onRegistrationOpenChange={vi.fn()}
        onManage={vi.fn()}
      />
    );
    expect(html).toContain('Registered · checking');
    expect(html).not.toContain('>Online<');
  });
  it('offers explicit registration again when the central record is missing', () => {
    const html = render(
      <LocalAccountHostSettings
        state={
          {
            data: registration,
            isSuccess: true,
            isPending: false,
            isError: false,
          } as never
        }
        hostsReady
        registrationOpen={false}
        onRegistrationOpenChange={vi.fn()}
        onManage={vi.fn()}
      />
    );
    expect(html).toContain('Register this computer again');
    expect(html).toContain('needs registration again');
    expect(html).not.toContain('Registered · checking');
    expect(html).not.toContain('>Recover host authentication</button>');
  });
  it('does not infer a missing registration before the central lookup succeeds', () => {
    const html = render(
      <LocalAccountHostSettings
        state={
          {
            data: registration,
            isSuccess: true,
            isPending: false,
            isError: false,
          } as never
        }
        hostsReady={false}
        registrationOpen={false}
        onRegistrationOpenChange={vi.fn()}
        onManage={vi.fn()}
      />
    );
    expect(html).not.toContain('Register this computer again');
    expect(html).toContain('Registered · checking');
  });
  it('shows power, app, and internet checks to shared users of offline computers', () => {
    const html = render(
      <AccountHostDetailsDialog
        host={host('shared', 'member', { status: 'offline' })}
        onClose={vi.fn()}
      />
    );
    expect(html).toContain('turned on');
    expect(html).toContain('Vibe Kanban is running');
    expect(html).toContain('internet connection');
    expect(html).toContain('do not need to sign in again');
    expect(html).not.toContain('>Recover host authentication</button>');
  });
  it('explains owner action instead of offline troubleshooting for paused sharing', () => {
    const html = render(
      <AccountHostDetailsDialog
        host={host('shared', 'member', {
          status: 'offline',
          remote_access_enabled: false,
        })}
        onClose={vi.fn()}
      />
    );
    expect(html).toContain('Ask the owner to turn remote access back on');
    expect(html).not.toContain('Vibe Kanban is running');
  });
  it('shows no connection troubleshooting for an online computer', () => {
    const html = render(
      <AccountHostDetailsDialog host={host('self')} onClose={vi.fn()} />
    );
    expect(html).not.toContain('Check that this computer is turned on');
    expect(html).not.toContain('Ask the owner to turn remote access back on');
  });
  it('keeps owner controls out of shared-computer details', () => {
    client.setQueryData(['host-connections', 'alice', 'shared'], []);
    const html = render(
      <AccountHostDetailsDialog
        host={host('shared', 'member')}
        onClose={vi.fn()}
      />
    );
    expect(html).toContain('My connections');
    expect(html).toContain('Only the owner');
    expect(html).not.toContain('Add account');
    expect(html).not.toContain('Unregister');
    expect(html).not.toContain('Save name');
  });
  it('shows only active access grants and protects the owner from removal', () => {
    client.setQueryData(['host-policy', 'alice', 'self'], {
      host_id: 'self',
      owner_user_id: 'alice',
      auth_mode: 'account',
      auth_generation: 3,
      grants: [
        { user_id: 'removed-user', revoked_at: '2026-10-15' },
        { user_id: 'active-user', revoked_at: null },
      ],
    });
    const html = render(
      <AccountHostDetailsDialog host={host('self')} onClose={vi.fn()} />
    );
    expect(html).toContain('active-u');
    expect(html).not.toContain('removed-');
    expect(html).toContain('cannot remove');
    expect(html.match(/>Remove access<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain('Unregister computer');
  });
  it('places signed-in devices and account ID in the account section', () => {
    client.setQueryData(
      ['account-sessions', 'alice'],
      [
        {
          id: 'device',
          device_label:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
          created_at: '2026-10-16T00:00:00Z',
          last_used_at: null,
          current: true,
        },
      ]
    );
    const html = render(<AccountSettingsSection />);
    expect(html).toContain('Signed-in devices');
    expect(html).toContain('Safari · iPhone');
    expect(html).toContain('My account ID');
    expect(html).not.toContain('Mozilla/5.0');
    expect(html).not.toContain('My computers');
  });

  it('restores a reauthentication draft but still requires account verification and consent', () => {
    client.setQueryData(['host-policy', 'alice', 'self'], {
      host_id: 'self',
      owner_user_id: 'alice',
      auth_mode: 'account',
      auth_generation: 3,
      grants: [],
    });
    const id = '3b889c00-478d-44a3-b2f8-767fb640948b';
    const html = render(
      <AccountHostSettings
        legacy={null}
        initialHostId="self"
        initialAccountId={id}
      />
    );
    expect(html).toContain(`value="${id}"`);
    expect(html).toContain('Verify account');
    expect(html).not.toContain('checked=');
    expect(html).toMatch(/disabled=""[^>]*>Allow access<\/button>/);
    const shareHtml = html.slice(html.lastIndexOf('<div role="dialog">'));
    const buttons = [
      ...shareHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g),
    ].map(([, attributes, label]) => ({
      label,
      disabled: attributes.includes('disabled=""'),
      primary: attributes.includes('data-dialog-primary'),
      getAttribute: (name: string) =>
        attributes.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null,
    }));
    const container = {
      querySelectorAll: (selector: string) =>
        buttons.filter((button) =>
          selector === 'button[data-dialog-primary]'
            ? button.primary
            : selector === 'button[type="submit"]'
              ? button.getAttribute('type') === 'submit'
              : true
        ),
    } as unknown as HTMLElement;
    const verify = buttons.find((button) => button.label === 'Verify account')!;
    const grant = buttons.find((button) => button.label === 'Allow access')!;
    expect(findDialogPrimaryAction(container)).toBe(verify);
    // Once verification and consent enable the final action, the shared shortcut follows it.
    grant.disabled = false;
    expect(findDialogPrimaryAction(container)).toBe(grant);
    grant.disabled = true;
    verify.disabled = true;
    expect(findDialogPrimaryAction(container)).toBeNull();
  });

  it('never offers registration under another account as an enabled action', () => {
    const state = {
      data: {
        ...registration,
        registration: { ...registration.registration!, owner_user_id: 'bob' },
      },
      isSuccess: true,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    };
    const html = render(
      <LocalAccountHostSettings
        state={state as never}
        hostsReady
        registrationOpen
        onRegistrationOpenChange={vi.fn()}
        onManage={vi.fn()}
      />
    );
    expect(html).toContain('registered to another account');
    expect(html).toMatch(
      /type="submit"[^>]*form="register-account-host"[^>]*disabled=""/
    );
  });
});
