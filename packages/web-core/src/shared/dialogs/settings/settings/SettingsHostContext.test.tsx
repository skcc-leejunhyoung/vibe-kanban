import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayHost } from 'shared/remote-types';
import { SettingsHostProvider, useSettingsHost } from './SettingsHostContext';
import {
  RELAY_REMOTE_HOSTS_QUERY_KEY,
  RELAY_REMOTE_PAIRED_HOSTS_QUERY_KEY,
} from '@/shared/lib/relayHostQueryKeys';

const mock = vi.hoisted(() => ({
  runtime: 'remote',
  routeHostId: 'account' as string | null,
  fetchHosts: vi.fn(),
  localHosts: [] as unknown[],
}));
vi.mock('@/shared/hooks/useAppRuntime', () => ({
  useAppRuntime: () => mock.runtime,
}));
vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({ isSignedIn: true, userId: 'alice' }),
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => mock.routeHostId,
}));
vi.mock('@/shared/hooks/useRemoteCloudHosts', () => ({
  useRemoteCloudHostsState: () => ({ data: { hosts: mock.localHosts } }),
}));
vi.mock('@/shared/lib/remoteApi', () => ({ listRelayHosts: mock.fetchHosts }));
vi.mock('@/shared/lib/relayPairingStorage', () => ({
  listPairedRelayHosts: vi.fn(async () => []),
  relayPairingRefetchInterval: () => 5000,
  subscribeRelayPairingChanges: () => () => {},
}));
vi.mock('@/shared/lib/machineClient', () => ({ createMachineClient: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_: string, fallback: string) => fallback }),
}));

let client: QueryClient;
let result: ReturnType<typeof useSettingsHost>;
function Probe() {
  result = useSettingsHost();
  return null;
}
function readTargets() {
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SettingsHostProvider>
        <Probe />
      </SettingsHostProvider>
    </QueryClientProvider>
  );
  return result.availableHosts;
}
function host(id: string, extra: Partial<RelayHost> = {}): RelayHost {
  return {
    id,
    name: id,
    owner_user_id: 'alice',
    machine_id: id,
    access_role: 'owner',
    auth_mode: 'account',
    auth_generation: 3,
    remote_access_enabled: true,
    status: 'online',
    last_seen_at: null,
    agent_version: null,
    created_at: '',
    updated_at: '',
    capabilities: [],
    ...extra,
  };
}
beforeEach(() => {
  mock.runtime = 'remote';
  mock.routeHostId = 'account';
  mock.localHosts = [];
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(RELAY_REMOTE_HOSTS_QUERY_KEY, [
    host('account'),
    host('shared', { access_role: 'member' }),
  ]);
  client.setQueryData(RELAY_REMOTE_PAIRED_HOSTS_QUERY_KEY, []);
});
afterEach(() => client.clear());

describe('settings host selection', () => {
  it('includes owned and shared account hosts without browser pairing', () => {
    expect(readTargets().map((target) => target.id)).toEqual([
      'remote',
      'account',
      'shared',
    ]);
  });
  it('requires browser pairing only for legacy hosts', () => {
    client.setQueryData(RELAY_REMOTE_HOSTS_QUERY_KEY, [
      host('account'),
      host('paired', { auth_mode: 'legacy_pairing' }),
      host('unpaired', { auth_mode: 'legacy_pairing' }),
    ]);
    client.setQueryData(RELAY_REMOTE_PAIRED_HOSTS_QUERY_KEY, [
      { host_id: 'paired' },
    ]);
    expect(readTargets().map((target) => target.id)).toEqual([
      'remote',
      'account',
      'paired',
    ]);
  });
  it('marks a paused account host offline even when its relay is online', () => {
    client.setQueryData(RELAY_REMOTE_HOSTS_QUERY_KEY, [
      host('account', { remote_access_enabled: false }),
    ]);
    expect(
      readTargets().find((target) => target.id === 'account')?.status
    ).toBe('offline');
  });
  it('does not require pairing storage to read account hosts', () => {
    client
      .getQueryCache()
      .find({ queryKey: RELAY_REMOTE_PAIRED_HOSTS_QUERY_KEY })!
      .setState({
        status: 'error',
        data: undefined,
        error: new Error('IDB unavailable'),
        fetchStatus: 'idle',
      });
    expect(readTargets().map((target) => target.id)).toEqual([
      'remote',
      'account',
      'shared',
    ]);
    expect(result.hostsResolved).toBe(true);
  });
  it('retains the local computer and local account host source on local web', () => {
    mock.runtime = 'local';
    mock.localHosts = [
      { id: 'local-account', name: 'Other Mac', status: 'online' },
    ];
    expect(readTargets().map((target) => target.id)).toEqual([
      'local',
      'local-account',
    ]);
  });
});

describe('settings host selection while lists change', () => {
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'document',
      Object.assign(new EventTarget(), { nodeType: 9, activeElement: null })
    );
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        document,
        HTMLIFrameElement: class {},
      })
    );
    const container = Object.assign(new EventTarget(), {
      nodeType: 1,
      tagName: 'DIV',
      ownerDocument: document,
    });
    root = createRoot(container as unknown as HTMLElement);
    mock.fetchHosts.mockImplementation(() => new Promise(() => {}));
    client.removeQueries({ queryKey: RELAY_REMOTE_HOSTS_QUERY_KEY });
  });
  afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  async function mount(initialHostId?: string) {
    await act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <SettingsHostProvider initialHostId={initialHostId}>
            <Probe />
          </SettingsHostProvider>
        </QueryClientProvider>
      )
    );
  }
  async function load(hosts: RelayHost[]) {
    await act(async () => {
      client.setQueryData(RELAY_REMOTE_HOSTS_QUERY_KEY, hosts);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  it('follows the current route host when the remote list arrives late', async () => {
    await mount();
    expect(result.hostsResolved).toBe(false);
    expect(result.selectedHostId).toBe('remote');
    await load([host('account')]);
    expect(result.hostsResolved).toBe(true);
    expect(result.selectedHostId).toBe('account');
  });
  it('prioritizes an explicit initial host over the route after loading', async () => {
    await mount('shared');
    await load([host('account'), host('shared')]);
    expect(result.selectedHostId).toBe('shared');
  });
  it('preserves a deliberate Remote choice made while the list loads', async () => {
    await mount();
    await act(() => result.setSelectedHostId('remote'));
    await load([host('account')]);
    expect(result.selectedHostId).toBe('remote');
  });
  it('preserves a user-selected machine across refreshes and route changes', async () => {
    await mount();
    await load([host('account'), host('shared')]);
    await act(() => result.setSelectedHostId('shared'));
    mock.routeHostId = null;
    await mount();
    await load([host('account', { name: 'renamed' }), host('shared')]);
    expect(result.selectedHostId).toBe('shared');
  });
  it('clears a user choice that disappears from the resolved list', async () => {
    mock.routeHostId = null;
    await mount();
    await load([host('account')]);
    await act(() => result.setSelectedHostId('account'));
    await load([]);
    expect(result.selectedHostId).toBe('remote');
    await load([host('account')]);
    expect(result.selectedHostId).toBe('remote');
  });
  it('also follows a late remote-machine list on local web', async () => {
    mock.runtime = 'local';
    await mount();
    expect(result.selectedHostId).toBe('local');
    mock.localHosts = [{ id: 'account', name: 'Other Mac', status: 'online' }];
    await mount();
    expect(result.selectedHostId).toBe('account');
  });
  it('preserves a deliberate local-computer choice after remote machines load', async () => {
    mock.runtime = 'local';
    await mount();
    await act(() => result.setSelectedHostId('local'));
    mock.localHosts = [{ id: 'account', name: 'Other Mac', status: 'online' }];
    await mount();
    expect(result.selectedHostId).toBe('local');
  });
});
