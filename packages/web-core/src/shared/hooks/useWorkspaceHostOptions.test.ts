import { describe, expect, it } from 'vitest';
import type { RelayHost } from 'shared/remote-types';
import type { PairedRelayHost } from '@/shared/lib/relayPairingStorage';
import { buildRelayHostOptions } from './useWorkspaceHostOptions';

function relayHost(overrides: Partial<RelayHost> & { id: string }): RelayHost {
  return {
    owner_user_id: 'owner',
    machine_id: 'machine',
    name: overrides.id,
    status: 'online',
    last_seen_at: null,
    agent_version: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    access_role: 'owner',
    ...overrides,
  };
}

function pairedHost(hostId: string): PairedRelayHost {
  return {
    host_id: hostId,
    host_name: hostId,
    paired_at: '2026-01-01T00:00:00Z',
  } as PairedRelayHost;
}

describe('buildRelayHostOptions', () => {
  it('marks paired + online relay hosts as online', () => {
    const options = buildRelayHostOptions(
      [relayHost({ id: 'h1', name: 'Host One', status: 'online' })],
      [pairedHost('h1')]
    );

    expect(options).toEqual([{ id: 'h1', name: 'Host One', status: 'online' }]);
  });

  it('marks paired but offline relay hosts as offline', () => {
    const options = buildRelayHostOptions(
      [relayHost({ id: 'h1', status: 'offline' })],
      [pairedHost('h1')]
    );

    expect(options[0].status).toBe('offline');
  });

  it('excludes hosts not paired directly with this browser', () => {
    const options = buildRelayHostOptions(
      [relayHost({ id: 'h1', status: 'online' })],
      []
    );

    expect(options).toEqual([]);
  });

  it('does not include hosts paired through another host', () => {
    const options = buildRelayHostOptions(
      [
        relayHost({ id: 'm4', name: 'm4-mbp' }),
        relayHost({ id: 'i9', name: 'i9-mbp' }),
      ],
      [pairedHost('m4')]
    );

    expect(options).toEqual([{ id: 'm4', name: 'm4-mbp', status: 'online' }]);
  });

  it('returns an empty list when there are no relay hosts', () => {
    expect(buildRelayHostOptions([], [pairedHost('h1')])).toEqual([]);
  });
});
