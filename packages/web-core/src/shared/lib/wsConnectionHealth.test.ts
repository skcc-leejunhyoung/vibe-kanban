import { beforeEach, describe, expect, it } from 'vitest';

import { WS_FAILURE_THRESHOLD, WsConnectionHealth } from './wsConnectionHealth';
import {
  clearWsSnapshots,
  getWsSnapshot,
  saveWsSnapshot,
} from './wsSnapshotCache';

describe('WsConnectionHealth', () => {
  beforeEach(() => {
    clearWsSnapshots();
  });

  it('surfaces failure when reconnecting to a previously-live endpoint without receiving a new message', () => {
    const health = new WsConnectionHealth();
    const endpoint = '/api/host/offline/workspaces/streams/ws';

    const initialConnection = health.startConnection(endpoint);
    health.markLive(initialConnection);
    const snapshot = { workspaces: { cached: true } };
    saveWsSnapshot(endpoint, snapshot);

    // Re-visiting the endpoint immediately serves its last materialized state.
    expect(getWsSnapshot(endpoint)).toBe(snapshot);

    // The new connection generations never receive a message.
    for (let attempt = 0; attempt < WS_FAILURE_THRESHOLD; attempt += 1) {
      const reconnect = health.startConnection(endpoint);
      expect(health.recordFailure(reconnect)).toBe(false);
    }

    const failedReconnect = health.startConnection(endpoint);
    expect(health.recordFailure(failedReconnect)).toBe(true);
  });

  it('clears consecutive failures only after the current generation receives a message', () => {
    const health = new WsConnectionHealth();
    const endpoint = '/api/execution-processes/stream/session/ws';

    for (let attempt = 0; attempt < WS_FAILURE_THRESHOLD; attempt += 1) {
      const connection = health.startConnection(endpoint);
      expect(health.recordFailure(connection)).toBe(false);
    }

    const liveConnection = health.startConnection(endpoint);
    health.markLive(liveConnection);
    expect(health.failureCount()).toBe(0);

    const nextConnection = health.startConnection(endpoint);
    expect(health.recordFailure(nextConnection)).toBe(false);
  });

  it('ignores failures from superseded connection generations', () => {
    const health = new WsConnectionHealth();
    const endpoint = '/api/workspaces/streams/ws';

    const staleConnection = health.startConnection(endpoint);
    health.startConnection(endpoint);

    expect(health.recordFailure(staleConnection)).toBe(false);
    expect(health.failureCount()).toBe(0);
  });
});
