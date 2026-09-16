import { describe, expect, it } from 'vitest';
import {
  AGENT_TURN_SETTLE_MS,
  agentTurnJustEnded,
} from './useAfterAgentTurnRefetch';

describe('agentTurnJustEnded', () => {
  it('fires only on running -> not running', () => {
    expect(agentTurnJustEnded(true, false)).toBe(true);
    expect(agentTurnJustEnded(false, true)).toBe(false);
    expect(agentTurnJustEnded(true, true)).toBe(false);
    expect(agentTurnJustEnded(false, false)).toBe(false);
  });

  it('never fires without an execution-process provider', () => {
    expect(agentTurnJustEnded(undefined, undefined)).toBe(false);
    expect(agentTurnJustEnded(undefined, false)).toBe(false);
    expect(agentTurnJustEnded(true, undefined)).toBe(false);
  });

  it('re-reads after the post-terminal write has landed, then once more', () => {
    // The auto-commit / pending-resume row is written after the completion
    // patch is published, so the first shot must not be immediate and there
    // must be a slower fallback.
    expect(AGENT_TURN_SETTLE_MS[0]).toBeGreaterThan(0);
    expect(AGENT_TURN_SETTLE_MS.length).toBeGreaterThan(1);
    expect(AGENT_TURN_SETTLE_MS).toEqual(
      [...AGENT_TURN_SETTLE_MS].sort((a, b) => a - b)
    );
  });
});
