import { describe, expect, it } from 'vitest';

import {
  shouldReconnectForStreamSilence,
  shouldResetRunningStreamWatchdog,
  type StreamSilenceDecisionInput,
} from './wsStreamHeartbeat';

const input = (
  overrides: Partial<StreamSilenceDecisionInput> = {}
): StreamSilenceDecisionInput => ({
  enabled: true,
  hasEndpoint: true,
  finished: false,
  isCurrentSocket: true,
  readyState: 1,
  ...overrides,
});

describe('shouldReconnectForStreamSilence', () => {
  it('reconnects a current, open stream after its heartbeat deadline', () => {
    expect(shouldReconnectForStreamSilence(input())).toBe(true);
  });

  it.each([
    ['the stream is disabled', { enabled: false }],
    ['there is no endpoint', { hasEndpoint: false }],
    ['the stream finished', { finished: true }],
    ['a newer socket replaced it', { isCurrentSocket: false }],
    ['the socket is no longer open', { readyState: 3 }],
  ] as const)('does not reconnect when %s', (_reason, overrides) => {
    expect(shouldReconnectForStreamSilence(input(overrides))).toBe(false);
  });
});

describe('shouldResetRunningStreamWatchdog', () => {
  it('arms reconciliation when a running process receives a state update', () => {
    expect(
      shouldResetRunningStreamWatchdog({
        hasRunningProcess: true,
        receivedHeartbeat: false,
      })
    ).toBe(true);
  });

  it('does not let heartbeats postpone stale running-process reconciliation', () => {
    expect(
      shouldResetRunningStreamWatchdog({
        hasRunningProcess: true,
        receivedHeartbeat: true,
      })
    ).toBe(false);
  });

  it('does not arm reconciliation for an already completed snapshot', () => {
    expect(
      shouldResetRunningStreamWatchdog({
        hasRunningProcess: false,
        receivedHeartbeat: false,
      })
    ).toBe(false);
  });
});
