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

  it('keeps paired hosts reachable when the cloud lookup fails', async () => {
    const error = new Error('cloud authentication failed');

    const state = await fetchRemoteCloudHostsState({
      listPairedHosts: vi.fn().mockResolvedValue([pairedHost()]),
      listCloudHosts: vi.fn().mockRejectedValue(error),
    });

    // Optimistic online so the host and its workspaces stay visible instead of
    // vanishing when only the cloud auth layer fails.
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
