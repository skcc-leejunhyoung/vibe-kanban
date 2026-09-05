import { describe, expect, it } from 'vitest';
import {
  getTranscriptEntries,
  parseTranscriptMessages,
  shouldPollTranscript,
} from './SubagentTranscriptDialog';

describe('parseTranscriptMessages', () => {
  it('turns the flattened transcript into chat messages', () => {
    expect(
      parseTranscriptMessages(
        '**User**\n\nInvestigate\n\n**Agent**\n\n_Tool:_ `Read`\n\nDone'
      )
    ).toEqual([
      { role: 'user', content: 'Investigate' },
      { role: 'agent', content: '_Tool:_ `Read`\n\nDone' },
    ]);
  });

  it('stops polling when hidden or when the live task finishes', () => {
    let live = true;
    const isLive = () => live;
    expect(shouldPollTranscript(true, isLive)).toBe(true);
    expect(shouldPollTranscript(false, isLive)).toBe(false);
    live = false;
    expect(shouldPollTranscript(true, isLive)).toBe(false);
  });

  it('normalizes legacy messages for the shared chat renderer', () => {
    expect(
      getTranscriptEntries({
        entries: [],
        content: '**User**\n\nquestion\n\n**Agent**\n\nanswer',
      })
    ).toEqual([
      {
        timestamp: null,
        entry_type: { type: 'user_message' },
        content: 'question',
      },
      {
        timestamp: null,
        entry_type: { type: 'assistant_message' },
        content: 'answer',
      },
    ]);
  });
});
