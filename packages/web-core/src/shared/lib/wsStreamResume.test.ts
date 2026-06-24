import { describe, it, expect } from 'vitest';
import {
  shouldReconnectOnResume,
  FREEZE_SUSPECT_MS,
  RESUME_CONNECT_TIMEOUT_MS,
  type ResumeDecisionInput,
} from './wsStreamResume';

// A baseline "healthy + just became visible" input. Individual tests override
// only the fields they exercise.
const input = (
  over: Partial<ResumeDecisionInput> = {}
): ResumeDecisionInput => ({
  enabled: true,
  hasEndpoint: true,
  finished: false,
  eventType: 'visibilitychange',
  persisted: false,
  visibilityState: 'visible',
  isConnected: true,
  isInitialized: true,
  hiddenDurationMs: 0,
  freezeSuspectMs: FREEZE_SUSPECT_MS,
  ...over,
});

describe('shouldReconnectOnResume', () => {
  describe('never reconnects', () => {
    it('when the stream is disabled', () => {
      expect(shouldReconnectOnResume(input({ enabled: false }))).toBe(false);
    });

    it('when there is no endpoint', () => {
      expect(shouldReconnectOnResume(input({ hasEndpoint: false }))).toBe(
        false
      );
    });

    it('when the stream has finished', () => {
      expect(shouldReconnectOnResume(input({ finished: true }))).toBe(false);
    });

    it('while the document is still hidden', () => {
      expect(
        shouldReconnectOnResume(input({ visibilityState: 'hidden' }))
      ).toBe(false);
    });

    it('on a pageshow that is not a bfcache restore (initial load)', () => {
      expect(
        shouldReconnectOnResume(
          input({ eventType: 'pageshow', persisted: false })
        )
      ).toBe(false);
    });
  });

  describe('existing behaviour: dead socket always reconnects', () => {
    it('reconnects when the socket is not connected', () => {
      expect(shouldReconnectOnResume(input({ isConnected: false }))).toBe(true);
    });

    it('reconnects when the stream is not initialized', () => {
      expect(shouldReconnectOnResume(input({ isInitialized: false }))).toBe(
        true
      );
    });

    it('reconnects on an online event when the socket is down', () => {
      expect(
        shouldReconnectOnResume(
          input({ eventType: 'online', isConnected: false })
        )
      ).toBe(true);
    });
  });

  describe('churn avoidance: healthy socket survives a brief hide', () => {
    it('keeps the socket after a short tab switch', () => {
      expect(shouldReconnectOnResume(input({ hiddenDurationMs: 1_000 }))).toBe(
        false
      );
    });

    it('keeps the socket just below the freeze threshold', () => {
      expect(
        shouldReconnectOnResume(
          input({ hiddenDurationMs: FREEZE_SUSPECT_MS - 1 })
        )
      ).toBe(false);
    });

    it('keeps a healthy socket on a transient online event', () => {
      expect(shouldReconnectOnResume(input({ eventType: 'online' }))).toBe(
        false
      );
    });
  });

  describe('freeze recovery: half-open zombie gets reconnected', () => {
    it('reconnects a seemingly-healthy socket after a long hide', () => {
      expect(
        shouldReconnectOnResume(
          input({ hiddenDurationMs: FREEZE_SUSPECT_MS + 1 })
        )
      ).toBe(true);
    });

    it('treats a hide exactly at the threshold as freeze-suspected', () => {
      expect(
        shouldReconnectOnResume(input({ hiddenDurationMs: FREEZE_SUSPECT_MS }))
      ).toBe(true);
    });

    it('reconnects a healthy socket on a bfcache restore', () => {
      expect(
        shouldReconnectOnResume(
          input({ eventType: 'pageshow', persisted: true })
        )
      ).toBe(true);
    });
  });

  it('uses a shorter resume watchdog than the default connect timeout', () => {
    // The resume reconnect should recover faster than a cold connect.
    expect(RESUME_CONNECT_TIMEOUT_MS).toBeLessThan(FREEZE_SUSPECT_MS);
  });
});
