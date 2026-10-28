import { act, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'shared/types';
import type { LocalApiRequestOptions } from '@/shared/lib/localApiTransport';
import { DEFAULT_CONFIG } from '@/shared/lib/defaultConfig';
import { installFakeDomReact } from '@/shared/lib/electric/electricTestKit';
import {
  RELAY_REMOTE_HOSTS_QUERY_KEY,
  RELAY_REMOTE_PAIRED_HOSTS_QUERY_KEY,
} from '@/shared/lib/relayHostQueryKeys';
import { SettingsHostProvider, useSettingsHost } from './SettingsHostContext';
import { SettingsMachineUserSystemProvider } from './SettingsMachineUserSystemProvider';
import { AutomationSettingsSection } from './AutomationSettingsSection';
import { useUserSystem } from '@/shared/hooks/useUserSystem';

type CheckboxProps = {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
};
const mock = vi.hoisted(() => ({
  runtime: 'remote' as 'local' | 'remote',
  request:
    vi.fn<
      (path: string, options?: LocalApiRequestOptions) => Promise<Response>
    >(),
  checkboxes: new Map<string, CheckboxProps>(),
  cards: new Map<string, ReactNode>(),
  retry: null as (() => void) | null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return String(fallback?.defaultValue ?? key).replace(
        /{{(\w+)}}/g,
        (_, name) => String(fallback?.[name] ?? '')
      );
    },
  }),
}));
vi.mock('./SettingsComponents', () => ({
  SettingsCard: ({
    title,
    description,
    children,
  }: {
    title: string;
    description: string;
    children: ReactNode;
  }) => {
    const card = (
      <section>
        <h3>{title}</h3>
        <p>{description}</p>
        {children}
      </section>
    );
    mock.cards.set(title, card);
    return card;
  },
  SettingsCheckbox: (props: CheckboxProps) => {
    mock.checkboxes.set(props.id, props);
    return null;
  },
  SettingsField: () => null,
  SettingsInput: () => null,
  SettingsSelect: () => null,
  SettingsTextarea: () => null,
}));
vi.mock('@vibe/ui/components/PrimaryButton', () => ({
  PrimaryButton: ({
    onClick,
    children,
  }: {
    onClick: () => void;
    children: ReactNode;
  }) => {
    if (children === 'Reload permissions') mock.retry = onClick;
    return null;
  },
}));
vi.mock('@/shared/lib/remoteApi', () => ({
  listProjectStatuses: vi.fn(),
  listRelayHosts: vi.fn(async () => []),
}));
vi.mock('@/shared/hooks/useAppRuntime', () => ({
  useAppRuntime: () => mock.runtime,
}));
vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({ isSignedIn: true, userId: 'owner' }),
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => null,
  getCurrentHostId: () => null,
}));
vi.mock('@/shared/hooks/useRemoteCloudHosts', () => ({
  useRemoteCloudHostsState: () => ({
    data: { hosts: [{ id: 'i9', name: 'i9-mbp', status: 'online' }] },
  }),
}));
vi.mock('@/shared/lib/relayPairingStorage', () => ({
  listPairedRelayHosts: vi.fn(async () => []),
  relayPairingRefetchInterval: () => 5000,
  subscribeRelayPairingChanges: () => () => {},
}));
vi.mock('@/shared/lib/localApiTransport', () => ({
  makeLocalApiRequest: (path: string, options?: LocalApiRequestOptions) =>
    mock.request(path, options),
}));

let client: QueryClient;
let dom: ReturnType<typeof installFakeDomReact>;
let selection: ReturnType<typeof useSettingsHost>;
let system: ReturnType<typeof useUserSystem>;
let persisted: Record<string, Config>;
let revisions: Record<string, number>;
let offline: boolean;

function Section() {
  system = useUserSystem();
  return <AutomationSettingsSection />;
}
function Scope() {
  selection = useSettingsHost();
  return selection.selectedHost?.kind === 'remote-shared' ? null : (
    <SettingsMachineUserSystemProvider>
      <Section />
    </SettingsMachineUserSystemProvider>
  );
}
function tree() {
  return (
    <QueryClientProvider client={client}>
      <SettingsHostProvider>
        <Scope />
      </SettingsHostProvider>
    </QueryClientProvider>
  );
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function selectHost(id: string) {
  await act(() => selection.setSelectedHostId(id));
  await flush();
}
async function mount(runtime: 'local' | 'remote' = 'remote') {
  mock.runtime = runtime;
  await dom.render(tree());
  await flush();
  await selectHost('i9');
}
const updateToggle = () => mock.checkboxes.get('agent-access-update_config')!;
const cardHtml = () =>
  renderToStaticMarkup(<>{mock.cards.get('Agent access')}</>);
const writes = () =>
  mock.request.mock.calls.filter(([, options]) => options?.method === 'PUT');

async function handleRequest(
  path: string,
  options: LocalApiRequestOptions = {}
): Promise<Response> {
  const id = options.relayHostId ?? options.hostId ?? 'main';
  if (offline && id === 'i9') throw new Error('host offline');
  const wrap = (data: unknown) =>
    new Response(JSON.stringify({ success: true, data }));
  const revision = `${id}-${revisions[id]}`;
  if (path === '/api/info') {
    return wrap({
      config: persisted[id],
      config_revision: revision,
      machine_id: `device-${id}`,
    });
  }
  if (path === '/api/config') {
    const body = JSON.parse(String(options.body)) as {
      config: Config;
      revision: string;
    };
    expect(options.method).toBe('PUT');
    expect(body.revision).toBe(revision);
    persisted[id] = body.config;
    revisions[id]++;
    return wrap({ config: persisted[id], revision: `${id}-${revisions[id]}` });
  }
  if (path === '/api/automation/state') {
    return new Response('automation worker unavailable', { status: 502 });
  }
  if (path === '/api/agent-memory-sync/status') {
    return new Response(
      JSON.stringify({ running: false, central_targets: [] })
    );
  }
  if (path.includes('/api/agent-memory-sync/')) return new Response('[]');
  throw new Error(`Unexpected path: ${path}`);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(RELAY_REMOTE_HOSTS_QUERY_KEY, [
    {
      id: 'i9',
      name: 'i9-mbp',
      machine_id: 'device-i9',
      owner_user_id: 'owner',
      auth_mode: 'account',
      remote_access_enabled: true,
      status: 'online',
      access_role: 'owner',
      capabilities: [],
    },
  ]);
  client.setQueryData(RELAY_REMOTE_PAIRED_HOSTS_QUERY_KEY, []);
  persisted = {
    i9: structuredClone(DEFAULT_CONFIG),
    main: structuredClone(DEFAULT_CONFIG),
  };
  revisions = { i9: 1, main: 1 };
  offline = false;
  mock.checkboxes.clear();
  mock.cards.clear();
  mock.retry = null;
  mock.request.mockReset().mockImplementation(handleRequest);
  dom = installFakeDomReact();
});
afterEach(async () => {
  await dom.unmount();
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Agent access through host selection and the machine client', () => {
  it.each(['local', 'remote'] as const)(
    'loads and saves only i9 on %s web despite worker 502',
    async (runtime) => {
      await mount(runtime);
      expect(selection.selectedHostId).toBe('i9');
      expect(updateToggle()).toMatchObject({ checked: false, disabled: false });
      expect(mock.checkboxes.get('automation-master')?.disabled).toBe(true);
      expect(cardHtml()).toContain('Target host: i9-mbp (device-i9)');
      expect(cardHtml()).toContain(
        'even when no Automation Worker is installed or reachable'
      );
      expect([...mock.cards.keys()].indexOf('Agent access')).toBeLessThan(
        [...mock.cards.keys()].indexOf('Automation Worker')
      );

      await act(() => updateToggle().onChange(true));
      await flush();
      expect(persisted.i9.agent_access.update_config).toBe(true);
      expect(persisted.main.agent_access.update_config).toBe(false);
      expect(updateToggle()).toMatchObject({ checked: true, disabled: false });
      expect(writes()).toHaveLength(1);
      expect(writes()[0][0]).toBe('/api/config');
      expect(writes()[0][1]).toMatchObject(
        runtime === 'local'
          ? { hostScope: 'explicit', hostId: 'i9' }
          : { hostScope: 'none', relayHostId: 'i9' }
      );
      expect(
        mock.request.mock.calls.some(
          ([path]) => path === '/api/automation/state'
        )
      ).toBe(true);
      expect(
        mock.request.mock.calls
          .filter(([, options]) => options?.method && options.method !== 'GET')
          .map(([path]) => path)
      ).toEqual(['/api/config']);
    }
  );

  it('saves Agent access without waiting for the worker request', async () => {
    mock.request.mockImplementation((path, options) =>
      path === '/api/automation/state'
        ? new Promise(() => {})
        : handleRequest(path, options)
    );
    await mount();
    await act(() => updateToggle().onChange(true));
    await flush();
    expect(persisted.i9.agent_access.update_config).toBe(true);
    expect(updateToggle()).toMatchObject({ checked: true, disabled: false });
  });

  it('keeps confirmed permissions until the host acknowledges a save', async () => {
    await mount();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mock.request.mockImplementationOnce(async (path, options) => {
      await pending;
      return handleRequest(path, options);
    });
    await act(() => updateToggle().onChange(true));
    await flush();
    expect(updateToggle()).toMatchObject({ checked: false, disabled: true });
    await act(() => finish());
    await flush();
    expect(updateToggle()).toMatchObject({ checked: true, disabled: false });
  });

  it('reconciles a failed save with a successful read of the stored value', async () => {
    await mount();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mock.request.mockRejectedValueOnce(new Error('save unavailable'));
    await act(() => updateToggle().onChange(true));
    await flush();
    expect(persisted.i9.agent_access.update_config).toBe(false);
    expect(updateToggle()).toMatchObject({ checked: false, disabled: false });
    expect(cardHtml()).toContain('Agent access save could not be confirmed');
  });

  it.each([false, true])(
    'keeps the confirmed value %s and the uncertainty warning after a failed save, read and host re-entry',
    async (confirmed) => {
      persisted.i9.agent_access.update_config = confirmed;
      await mount();
      offline = true;
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await act(() => updateToggle().onChange(!confirmed));
      await flush();
      expect(persisted.i9.agent_access.update_config).toBe(confirmed);
      expect(updateToggle()).toMatchObject({
        checked: confirmed,
        disabled: true,
      });
      expect(cardHtml()).toContain('last confirmed values');

      await selectHost('remote');
      await selectHost('i9');
      expect(updateToggle()).toMatchObject({
        checked: confirmed,
        disabled: true,
      });
      expect(cardHtml()).toContain('last confirmed values');

      offline = false;
      expect(mock.retry).not.toBeNull();
      await act(() => mock.retry!());
      await flush();
      expect(updateToggle()).toMatchObject({
        checked: confirmed,
        disabled: false,
      });
      expect(cardHtml()).not.toContain('last confirmed values');
      await act(() => updateToggle().onChange(!confirmed));
      await flush();
      expect(persisted.i9.agent_access.update_config).toBe(!confirmed);
    }
  );

  it.each([false, true])(
    'reconciles an applied write with a lost response when the previous value was %s',
    async (confirmed) => {
      persisted.i9.agent_access.update_config = confirmed;
      await mount();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mock.request.mockImplementationOnce(async (path, options) => {
        await handleRequest(path, options);
        throw new Error('save response lost');
      });
      await act(() => updateToggle().onChange(!confirmed));
      await flush();
      expect(persisted.i9.agent_access.update_config).toBe(!confirmed);
      expect(updateToggle()).toMatchObject({
        checked: !confirmed,
        disabled: false,
      });
      expect(cardHtml()).toContain('Agent access save could not be confirmed');
      await act(() => updateToggle().onChange(confirmed));
      await flush();
      expect(persisted.i9.agent_access.update_config).toBe(confirmed);
    }
  );

  it('shows uncertainty when an applied write loses its response and the host disconnects', async () => {
    await mount();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mock.request.mockImplementationOnce(async (path, options) => {
      await handleRequest(path, options);
      offline = true;
      throw new Error('save response lost');
    });
    await act(() => updateToggle().onChange(true));
    await flush();
    expect(persisted.i9.agent_access.update_config).toBe(true);
    expect(updateToggle()).toMatchObject({ checked: false, disabled: true });
    expect(cardHtml()).toContain('last confirmed values');
    offline = false;
    await act(() => mock.retry!());
    await flush();
    expect(updateToggle()).toMatchObject({ checked: true, disabled: false });
  });

  it('does not apply a late i9 save response to the selected local host', async () => {
    await mount('local');
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mock.request.mockImplementationOnce(async (path, options) => {
      await pending;
      return handleRequest(path, options);
    });
    await act(() => updateToggle().onChange(true));
    await selectHost('local');
    await act(() => finish());
    await flush();
    expect(persisted.i9.agent_access.update_config).toBe(true);
    expect(persisted.main.agent_access.update_config).toBe(false);
    expect(updateToggle().checked).toBe(false);
    expect(cardHtml()).toContain('This machine (device-main)');
    await act(() => updateToggle().onChange(true));
    await flush();
    expect(writes()[1][1]).toMatchObject({ hostScope: 'none' });
    await selectHost('i9');
    expect(updateToggle().checked).toBe(true);
  });

  it('keeps uncertainty visible after host re-entry while reconciliation is pending', async () => {
    await mount();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mock.request.mockImplementation(async (path, options) => {
      if (path === '/api/config') {
        await handleRequest(path, options);
        throw new Error('save response lost');
      }
      if (path === '/api/info') await pending;
      return handleRequest(path, options);
    });
    await act(() => updateToggle().onChange(true));
    await flush();
    await selectHost('remote');
    await selectHost('i9');
    expect(persisted.i9.agent_access.update_config).toBe(true);
    expect(updateToggle()).toMatchObject({ checked: false, disabled: true });
    expect(cardHtml()).toContain('Checking current Agent access on this host');
    await act(() => finish());
    await flush();
    expect(updateToggle()).toMatchObject({ checked: true, disabled: false });
  });

  it('keeps the selected host card visible when its config cannot be loaded', async () => {
    offline = true;
    await mount();
    expect(cardHtml()).toContain('Target host: i9-mbp (i9)');
    expect(cardHtml()).toContain('Could not load Agent access for this host');
    expect(writes()).toHaveLength(0);
  });

  it('preserves optimistic updates for preferences outside Agent access', async () => {
    await mount();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mock.request.mockImplementationOnce(async (path, options) => {
      await pending;
      return handleRequest(path, options);
    });
    let result!: Promise<boolean>;
    await act(() => {
      result = system.updateAndSaveConfig({ language: 'KO' });
    });
    await flush();
    expect(system.config?.language).toBe('KO');
    expect(persisted.i9.language).toBe('BROWSER');
    await act(async () => {
      finish();
      expect(await result).toBe(true);
    });
    expect(persisted.i9.language).toBe('KO');
  });
});
