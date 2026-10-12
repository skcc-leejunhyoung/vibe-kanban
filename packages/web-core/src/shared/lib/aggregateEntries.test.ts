import { describe, expect, it } from 'vitest';
import type { NormalizedEntryType } from 'shared/types';
import type {
  DisplayEntry,
  PatchTypeWithKey,
} from '@/shared/hooks/useConversationHistory/types';
import {
  aggregateConsecutiveEntries,
  collapseCompletedTurnSteps,
  countCollapsedSteps,
} from './aggregateEntries';

let index = 0;
function entry(
  type: NormalizedEntryType = { type: 'assistant_message' },
  key = `p:${index++}`
): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    content: { entry_type: type, content: 'text', timestamp: null },
    patchKey: key,
    executionProcessId: 'p',
  };
}
const user = (key = `p:user`) => entry({ type: 'user_message' }, key);
const thinking = () => entry({ type: 'thinking' });
const answer = () => entry();
const loading = () => entry({ type: 'loading' });
const error = () =>
  entry({ type: 'error_message', error_type: { type: 'other' } });
const read = (status: 'success' | 'pending_approval' = 'success') =>
  entry({
    type: 'tool_use',
    tool_name: 'Read',
    action_type: { action: 'file_read', path: 'a.ts' },
    status:
      status === 'success'
        ? { status: 'success' }
        : { status: 'pending_approval', approval_id: 'a' },
  });
const shape = (entries: DisplayEntry[]) =>
  entries.map((e) =>
    e.type === 'AGGREGATED_STEPS_GROUP'
      ? `steps(${e.entries.map((s) => s.type).join(',')})`
      : e.type === 'NORMALIZED_ENTRY'
        ? e.content.entry_type.type
        : e.type
  );
const collapse = (entries: PatchTypeWithKey[]) =>
  collapseCompletedTurnSteps(aggregateConsecutiveEntries(entries));

describe('collapseCompletedTurnSteps', () => {
  it('folds everything before the final answer of a finished turn', () => {
    const result = collapse([
      user(),
      thinking(),
      read(),
      read(),
      answer(),
      read(),
      answer(),
    ]);
    expect(shape(result)).toEqual([
      'user_message',
      'steps(NORMALIZED_ENTRY,AGGREGATED_GROUP,NORMALIZED_ENTRY,NORMALIZED_ENTRY)',
      'assistant_message',
    ]);
    const group = result[1];
    if (group.type !== 'AGGREGATED_STEPS_GROUP') throw new Error('no group');
    expect(group.patchKey).toBe('agg-steps:p:0');
    expect(countCollapsedSteps(group)).toBe(5);
  });

  it('leaves running, approval-blocked and answer-only turns alone', () => {
    expect(shape(collapse([user(), thinking(), read(), loading()]))).toEqual([
      'user_message',
      'thinking',
      'tool_use',
      'loading',
    ]);
    expect(shape(collapse([user(), read(), read('pending_approval')]))).toEqual(
      ['user_message', 'AGGREGATED_GROUP']
    );
    expect(shape(collapse([user(), answer()]))).toEqual([
      'user_message',
      'assistant_message',
    ]);
  });

  it('keeps the trailing errors of a turn that ended without an answer', () => {
    expect(
      shape(collapse([user(), read(), thinking(), error(), error()]))
    ).toEqual([
      'user_message',
      'steps(NORMALIZED_ENTRY,NORMALIZED_ENTRY)',
      'error_message',
      'error_message',
    ]);
    // Without an answer or error, the last step shows how the turn ended.
    expect(shape(collapse([user(), read(), thinking()]))).toEqual([
      'user_message',
      'steps(NORMALIZED_ENTRY)',
      'thinking',
    ]);
    expect(shape(collapse([user(), read()]))).toEqual([
      'user_message',
      'tool_use',
    ]);
  });

  it('keeps the user answers and feedback in view between collapsed steps', () => {
    const answered = entry({ type: 'user_answered_questions', answers: [] });
    const feedback = entry({ type: 'user_feedback', denied_tool: 'Bash' });
    expect(
      shape(
        collapse([
          user(),
          thinking(),
          read(),
          answered,
          read(),
          read(),
          feedback,
          thinking(),
          answer(),
        ])
      )
    ).toEqual([
      'user_message',
      'steps(NORMALIZED_ENTRY)',
      'tool_use',
      'user_answered_questions',
      'AGGREGATED_GROUP',
      'user_feedback',
      'steps(NORMALIZED_ENTRY)',
      'assistant_message',
    ]);
  });

  it('counts a streamed thinking group as one step', () => {
    const result = collapse([
      user(),
      thinking(),
      thinking(),
      read(),
      read(),
      answer(),
    ]);
    const group = result[1];
    if (group.type !== 'AGGREGATED_STEPS_GROUP') throw new Error('no group');
    expect(group.entries.map((e) => e.type)).toEqual([
      'AGGREGATED_THINKING_GROUP',
      'AGGREGATED_GROUP',
    ]);
    expect(countCollapsedSteps(group)).toBe(3);
  });

  it('treats user prompts, setup scripts and handoffs as turn boundaries', () => {
    const script = entry(
      {
        type: 'tool_use',
        tool_name: 'Setup Script',
        action_type: {
          action: 'command_run',
          command: 'setup',
          result: null,
          category: 'other',
        },
        status: { status: 'success' },
      },
      's:script'
    );
    const handoff = entry({ type: 'system_message' }, 'h:handoff');
    expect(
      shape(
        collapse([
          read(),
          answer(),
          script,
          user('s:user'),
          read(),
          answer(),
          handoff,
          thinking(),
          answer(),
          user('q:user'),
          read(),
          answer(),
        ])
      )
    ).toEqual([
      'steps(NORMALIZED_ENTRY)',
      'assistant_message',
      'tool_use',
      'user_message',
      'steps(NORMALIZED_ENTRY)',
      'assistant_message',
      'system_message',
      // Thinking before the last prompt is already grouped by the first pass.
      'steps(AGGREGATED_THINKING_GROUP)',
      'assistant_message',
      'user_message',
      'steps(NORMALIZED_ENTRY)',
      'assistant_message',
    ]);
  });

  it('does not treat a blank assistant message as the answer', () => {
    const blank = entry({ type: 'assistant_message' });
    blank.content.content = '  ';
    expect(
      shape(collapse([user(), read(), answer(), thinking(), blank]))
    ).toEqual([
      'user_message',
      'steps(NORMALIZED_ENTRY)',
      'assistant_message',
      'thinking',
      'assistant_message',
    ]);
  });

  it('is idempotent', () => {
    const once = collapse([user(), read(), answer()]);
    expect(collapseCompletedTurnSteps(once)).toEqual(once);
  });
});
