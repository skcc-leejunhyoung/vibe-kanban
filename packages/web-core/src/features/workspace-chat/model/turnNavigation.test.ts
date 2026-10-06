import { describe, expect, it } from 'vitest';
import type { ExecutionProcess } from 'shared/types';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import { buildTurnNavigationItems } from './turnNavigation';

const process = (
  id: string,
  second: number,
  typ: Record<string, unknown>
): ExecutionProcess =>
  ({
    id,
    created_at: `2026-10-06T00:00:${String(second).padStart(2, '0')}Z`,
    executor_action: { typ, next_action: null },
  }) as unknown as ExecutionProcess;

const script = process('script', 0, { type: 'ScriptRequest', script: 'setup' });
const first = process('first', 1, {
  type: 'CodingAgentInitialRequest',
  prompt: 'first prompt',
  handoff_from: null,
});
const second = process('second', 2, {
  type: 'CodingAgentFollowUpRequest',
  prompt: 'second prompt',
});

const userEntry = (processId: string, content: string): PatchTypeWithKey => ({
  type: 'NORMALIZED_ENTRY',
  content: { entry_type: { type: 'user_message' }, content, timestamp: null },
  patchKey: `${processId}:user`,
  executionProcessId: processId,
});

describe('buildTurnNavigationItems', () => {
  it('lists every coding turn; loaded ones keep their entry key, the rest page in by process', () => {
    const turns = buildTurnNavigationItems(
      [userEntry('second', 'second prompt')],
      [second, script, first]
    );
    expect(turns).toEqual([
      { patchKey: 'proc:first', content: 'first prompt', turnNumber: 1 },
      { patchKey: 'second:user', content: 'second prompt', turnNumber: 2 },
    ]);
  });

  it('attributes the prompt emitted under the setup-script process to the turn it starts', () => {
    // Once the script process is loaded the first prompt is keyed to it, not
    // to the coding process; the navigator must still treat turn 1 as loaded.
    const turns = buildTurnNavigationItems(
      [
        userEntry('script', 'first prompt'),
        userEntry('second', 'second prompt'),
      ],
      [script, first, second]
    );
    expect(turns.map((turn) => turn.patchKey)).toEqual([
      'script:user',
      'second:user',
    ]);
  });

  it('keeps a review prompt off the follow-up turn after it', () => {
    const review = process('review', 3, {
      type: 'ReviewRequest',
      prompt: 'review prompt',
    });
    const third = process('third', 4, {
      type: 'CodingAgentFollowUpRequest',
      prompt: 'third prompt',
    });
    const turns = buildTurnNavigationItems(
      [
        userEntry('first', 'first prompt'),
        userEntry('review', 'review prompt'),
        userEntry('third', 'third prompt'),
      ],
      [first, review, third]
    );
    expect(turns).toEqual([
      { patchKey: 'first:user', content: 'first prompt', turnNumber: 1 },
      { patchKey: 'third:user', content: 'third prompt', turnNumber: 2 },
    ]);
  });

  it('skips handoff turns without a user prompt', () => {
    const handoff = process('handoff', 3, {
      type: 'CodingAgentInitialRequest',
      prompt: 'internal',
      handoff_from: 'CODEX',
      handoff_user_prompt: null,
    });
    expect(buildTurnNavigationItems([], [first, handoff])).toHaveLength(1);
  });
});
