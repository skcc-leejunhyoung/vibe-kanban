import { describe, expect, it } from 'vitest';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import { computeLiveStatus } from './useLiveStatus';

let n = 0;
function entry(type: string, content = ''): PatchTypeWithKey {
  n += 1;
  return {
    type: 'NORMALIZED_ENTRY',
    content: { entry_type: { type }, content, timestamp: null },
    patchKey: `p1:${n}`,
    executionProcessId: 'p1',
  } as unknown as PatchTypeWithKey;
}

describe('computeLiveStatus', () => {
  it('streams the open block of the newest message', () => {
    const live = computeLiveStatus([
      entry('assistant_message', '```vibe-status\n첫 요약이에요.\n```'),
      entry('assistant_message', '```vibe-status\n두 번째 요약을 쓰는'),
      entry('token_usage_info'),
    ]);
    expect(live.draft).toMatchObject({
      text: '두 번째 요약을 쓰는',
      closed: false,
    });
    expect(live.history.map((item) => item.text)).toEqual(['첫 요약이에요.']);
  });

  it('settles an unclosed block once the agent moves on to a tool call', () => {
    const live = computeLiveStatus([
      entry('assistant_message', '```vibe-status\n닫지 않은 요약'),
      entry('tool_use'),
    ]);
    expect(live.draft).toMatchObject({ text: '닫지 않은 요약', closed: true });
    expect(live.history.map((item) => item.text)).toEqual(['닫지 않은 요약']);
  });

  it('keeps streaming when only a stderr line or a user message follows', () => {
    const live = computeLiveStatus([
      entry('assistant_message', '```vibe-status\n쓰는 중인 요약'),
      entry('error_message'),
      entry('user_message'),
    ]);
    expect(live.draft).toMatchObject({ text: '쓰는 중인 요약', closed: false });
  });

  it('dates history items by their message when it has a time', () => {
    const dated = entry(
      'assistant_message',
      '```vibe-status\n시각 있는 요약.\n```'
    );
    (dated.content as { timestamp: string | null }).timestamp =
      '2026-10-14T02:10:51.995Z';
    expect(computeLiveStatus([dated]).history[0]).toMatchObject({
      text: '시각 있는 요약.',
      at: '2026-10-14T02:10:51.995Z',
    });
    expect(
      computeLiveStatus([entry('assistant_message', '```vibe-status\nB.\n```')])
        .history[0].at
    ).toBeNull();
  });

  it('keeps each text once in history, newest copy first', () => {
    const live = computeLiveStatus([
      entry('assistant_message', '```vibe-status\nA.\n```'),
      entry('assistant_message', '```vibe-status\nB.\n```'),
      entry('assistant_message', '```vibe-status\nA.\n```'),
    ]);
    expect(live.history.map((item) => item.text)).toEqual(['A.', 'B.']);
  });
});
