import { describe, expect, it } from 'vitest';

import {
  shouldReconnectForStreamSilence,
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
