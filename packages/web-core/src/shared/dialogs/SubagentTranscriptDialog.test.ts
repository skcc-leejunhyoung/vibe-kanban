import { describe, expect, it } from 'vitest';
import {
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

  it('stops polling when the live task finishes', () => {
    let live = true;
    const isLive = () => live;
    expect(shouldPollTranscript(isLive)).toBe(true);
    live = false;
    expect(shouldPollTranscript(isLive)).toBe(false);
  });
});
