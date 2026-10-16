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
  localHosts: [] as unknown[],
}));
vi.mock('@/shared/hooks/useAppRuntime', () => ({
  useAppRuntime: () => mock.runtime,
}));
vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({ isSignedIn: true, userId: 'alice' }),
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => 'account',
}));
vi.mock('@/shared/hooks/useRemoteCloudHosts', () => ({
  useRemoteCloudHostsState: () => ({ data: { hosts: mock.localHosts } }),
}));
vi.mock('@/shared/lib/remoteApi', () => ({ listRelayHosts: vi.fn() }));
vi.mock('@/shared/lib/relayPairingStorage', () => ({
  listPairedRelayHosts: vi.fn(),
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
