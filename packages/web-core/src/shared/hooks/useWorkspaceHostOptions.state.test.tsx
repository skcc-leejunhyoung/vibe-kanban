import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { AppRuntimeProvider } from './useAppRuntime';
import { listRelayHosts } from '@/shared/lib/remoteApi';
import { listPairedRelayHosts } from '@/shared/lib/relayPairingStorage';
import { useWorkspaceHostOptions } from './useWorkspaceHostOptions';

const env = vi.hoisted(() => ({
  local: {
    data: { hosts: [], pairingError: null as unknown },
    error: null as unknown,
    isPending: false,
    isFetching: false,
    refetch: vi.fn(),
  },
}));
vi.mock('./useRemoteCloudHosts', () => ({
  useRemoteCloudHostsState: () => env.local,
}));
vi.mock('@/shared/lib/remoteApi', () => ({ listRelayHosts: vi.fn() }));
vi.mock('@/shared/lib/relayPairingStorage', () => ({
  listPairedRelayHosts: vi.fn(),
  relayPairingRefetchInterval: () => 30_000,
  subscribeRelayPairingChanges: () => () => {},
}));
let dom: ReturnType<typeof installDomlessReact>;
let client: QueryClient;
let state: ReturnType<typeof useWorkspaceHostOptions>;
beforeEach(() => {
  dom = installDomlessReact();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.clearAllMocks();
  env.local = {
    data: { hosts: [], pairingError: null },
    error: null,
    isPending: false,
    isFetching: false,
    refetch: vi.fn(),
  };
  vi.mocked(listRelayHosts).mockResolvedValue([
    {
      id: 'account-test',
      name: 'Account host',
      auth_mode: 'account',
      status: 'online',
      remote_access_enabled: true,
    },
    {
      id: 'legacy-test',
      name: 'Legacy host',
      auth_mode: 'legacy_pairing',
      status: 'online',
      remote_access_enabled: true,
    },
  ] as Awaited<ReturnType<typeof listRelayHosts>>);
  vi.mocked(listPairedRelayHosts).mockResolvedValue([]);
});
afterEach(async () => {
  await dom.unmount();
  client.clear();
  vi.unstubAllGlobals();
});
async function render(runtime: 'local' | 'remote') {
  function Probe() {
    state = useWorkspaceHostOptions();
    return null;
  }
  await dom.render(
    <QueryClientProvider client={client}>
      <AppRuntimeProvider runtime={runtime}>
        <Probe />
      </AppRuntimeProvider>
    </QueryClientProvider>
  );
}

it('does not treat inactive remote queries as loading in the local runtime', async () => {
  env.local.error = new Error('local hosts unavailable');
  await render('local');
  expect(state.isLoading).toBe(false);
  expect(state.error).toBe(env.local.error);
  state.retry();
  expect(env.local.refetch).toHaveBeenCalledOnce();
  expect(listRelayHosts).not.toHaveBeenCalled();
});
it('allows account hosts while the remote pairing store is still loading', async () => {
  vi.mocked(listPairedRelayHosts).mockImplementation(
    () => new Promise(() => {})
  );
  await render('remote');
  await vi.waitFor(() =>
    expect(state.hosts.map((host) => host.id)).toEqual(['account-test'])
  );
  expect(state.isLoading).toBe(false);
});
it('retains account hosts on pairing failure and retries only the failed source', async () => {
  const failure = new Error('pairings unavailable');
  vi.mocked(listPairedRelayHosts).mockRejectedValue(failure);
  await render('remote');
  await vi.waitFor(() => expect(state.partialError).toBe(failure));
  expect(state.error).toBeNull();
  expect(state.hosts.map((host) => host.id)).toEqual(['account-test']);
  vi.mocked(listPairedRelayHosts).mockResolvedValue([]);
  await act(() => state.retry());
  await vi.waitFor(() => expect(state.partialError).toBeNull());
  expect(listRelayHosts).toHaveBeenCalledTimes(1);
  expect(listPairedRelayHosts).toHaveBeenCalledTimes(2);
});
it('keeps the authoritative cloud error visible even with cached hosts', async () => {
  await render('remote');
  await vi.waitFor(() => expect(state.hosts).toHaveLength(1));
  const error = Object.assign(new Error('expired'), { status: 401 });
  vi.mocked(listRelayHosts).mockRejectedValue(error);
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['relay', 'remote', 'hosts'] });
  });
  await vi.waitFor(() => expect(state.error).toBe(error));
  expect(state.hosts).toHaveLength(1);
});
