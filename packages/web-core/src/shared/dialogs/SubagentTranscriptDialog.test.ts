import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  parseTranscriptMessages,
  shouldPollTranscript,
  TranscriptMessageFrame,
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

  it('visually and semantically separates input from output', () => {
    const input = renderToStaticMarkup(
      createElement(
        TranscriptMessageFrame,
        { role: 'user', label: 'Input' },
        'question'
      )
    );
    const output = renderToStaticMarkup(
      createElement(
        TranscriptMessageFrame,
        { role: 'agent', label: 'Output' },
        'answer'
      )
    );

    expect(input).toContain('aria-label="Input"');
    expect(input).toContain('justify-end');
    expect(output).toContain('aria-label="Output"');
    expect(output).toContain('justify-start');
  });
});
