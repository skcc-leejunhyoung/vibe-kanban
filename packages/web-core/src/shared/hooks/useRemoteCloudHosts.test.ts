import { describe, expect, it, vi } from 'vitest';
import type { RelayHost } from 'shared/remote-types';
import type { RelayPairedHost } from 'shared/types';
import { fetchRemoteCloudHostsState } from './useRemoteCloudHosts';

function relayHost(overrides: Partial<RelayHost> = {}): RelayHost {
  return {
    id: 'i9',
    owner_user_id: 'owner',
    machine_id: 'machine',
    name: 'i9-mbp',
    status: 'online',
    last_seen_at: null,
    agent_version: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    access_role: 'owner',
    auth_mode: 'legacy_pairing',
    auth_generation: 1,
    remote_access_enabled: true,
    capabilities: [],
    ...overrides,
  };
}

function pairedHost(): RelayPairedHost {
  return {
    host_id: 'i9',
    host_name: 'i9-mbp',
    paired_at: '2026-01-01T00:00:00Z',
  };
}

describe('fetchRemoteCloudHostsState', () => {
  it('uses the cloud status for a paired host', async () => {
    const state = await fetchRemoteCloudHostsState({
      listPairedHosts: vi.fn().mockResolvedValue([pairedHost()]),
      listCloudHosts: vi.fn().mockResolvedValue([relayHost()]),
    });

    expect(state.hosts).toEqual([
      {
        id: 'i9',
        name: 'i9-mbp',
        status: 'online',
        pairedAt: '2026-01-01T00:00:00Z',
        lastUsedAt: '2026-01-01T00:00:00Z',
      },
    ]);
  });

  it('reports cloud lookup failure instead of silently removing account hosts', async () => {
    const error = new Error('cloud unavailable');
    await expect(
      fetchRemoteCloudHostsState({
        listPairedHosts: async () => [pairedHost()],
        listCloudHosts: async () => {
          throw error;
        },
      })
    ).rejects.toBe(error);
  });
  it('lists account hosts without depending on a working pairing store', async () => {
    const state = await fetchRemoteCloudHostsState({
      listPairedHosts: async () => {
        throw new Error('no pairing');
      },
      listCloudHosts: async () => [
        relayHost({ auth_mode: 'account', remote_access_enabled: true }),
      ],
    });
    expect(state.hosts).toHaveLength(1);
    expect(state.hosts[0].id).toBe('i9');
  });

  it('does not list this machine as a remote account host', async () => {
    const state = await fetchRemoteCloudHostsState({
      listPairedHosts: async () => [],
      listCloudHosts: async () => [
        relayHost({ id: 'self', auth_mode: 'account' }),
        relayHost({ auth_mode: 'account' }),
      ],
      getSelfHostId: async () => 'self',
    });
    expect(state.hosts.map((host) => host.id)).toEqual(['i9']);
  });

  it('does not report an empty host list when the pairing lookup fails', async () => {
    const error = new Error('pairing store unavailable');

    await expect(
      fetchRemoteCloudHostsState({
        listPairedHosts: vi.fn().mockRejectedValue(error),
        listCloudHosts: vi.fn().mockResolvedValue([relayHost()]),
      })
    ).rejects.toBe(error);
  });
});
