import { describe, expect, it } from 'vitest';
import {
  extractLastStatusBlock,
  splitStatusSegments,
  statusFirstSentence,
  statusParagraphs,
  statusPlainText,
  statusTruncate,
} from './statusNote';

describe('splitStatusSegments', () => {
  it('separates closed summary blocks from the surrounding markdown', () => {
    const content =
      'Done.\n\n```vibe-status\n로그인 문제를 고쳤어요.\n검토를 기다려요.\n```\n\nNext steps.';
    expect(splitStatusSegments(content)).toEqual([
      { kind: 'markdown', text: 'Done.\n' },
      {
        kind: 'status',
        text: '로그인 문제를 고쳤어요.\n검토를 기다려요.',
        closed: true,
      },
      { kind: 'markdown', text: '\nNext steps.' },
    ]);
  });

  it('reports a streaming block as open and keeps other fences as markdown', () => {
    expect(splitStatusSegments('text\n  ~~~VIBE-STATUS\nstill typ')).toEqual([
      { kind: 'markdown', text: 'text' },
      { kind: 'status', text: 'still typ', closed: false },
    ]);
    const code = '```rust\nlet x = 1;\n```\n```vibe-status\nreal\n```';
    expect(splitStatusSegments(code)).toEqual([
      { kind: 'markdown', text: '```rust\nlet x = 1;\n```' },
      { kind: 'status', text: 'real', closed: true },
    ]);
  });

  it('ignores a quoted example nested inside another fence', () => {
    const nested = '````md\n```vibe-status\nnot a summary\n```\n````';
    expect(splitStatusSegments(nested)).toEqual([
      { kind: 'markdown', text: nested },
    ]);
    expect(extractLastStatusBlock(nested)).toBeUndefined();
  });

  it('closes on a fence followed by trailing whitespace, like CommonMark', () => {
    const spaced = '```vibe-status\nsummary here.\n```  \nVIBE_RESULT: done';
    expect(splitStatusSegments(spaced)).toEqual([
      { kind: 'status', text: 'summary here.', closed: true },
      { kind: 'markdown', text: 'VIBE_RESULT: done' },
    ]);
  });

  it('cuts to the visible limit exactly like the server', () => {
    const text = 'abc [link](x.html "vibe-artifact") def';
    expect(statusTruncate(text, 100)).toBe(text);
    expect(statusTruncate(text, 8)).toBe('abc [link](x.html "vibe-artifact")…');
    expect(statusTruncate(text, 6)).toBe('abc li…');
    expect(statusTruncate('가나다라마', 3)).toBe('가나다…');
    expect(statusTruncate('abc   ', 2)).toBe('ab…');
    expect(statusTruncate('가'.repeat(1001)).length).toBe(1001);
  });

  it('returns the last block of a message', () => {
    const content =
      '```vibe-status\nfirst\n```\nmore\n```vibe-status\nsecond\n```';
    expect(extractLastStatusBlock(content)).toEqual({
      text: 'second',
      closed: true,
    });
  });
});

describe('statusFirstSentence', () => {
  it('stops at terminal punctuation followed by whitespace', () => {
    expect(
      statusFirstSentence(
        '원인은 [응답 지연](x.html "vibe-artifact")이에요. 0.8초를 넘으면 생겨요.'
      )
    ).toBe('원인은 응답 지연이에요.');
    expect(statusFirstSentence('응답이 0.8초를 넘으면 비어요.\n다음 줄')).toBe(
      '응답이 0.8초를 넘으면 비어요.'
    );
  });

  it('ends at full-width stops without needing a space after them', () => {
    expect(
      statusFirstSentence(
        'ログイン直後の画面が空になる問題を直しています。次にテストを流します。'
      )
    ).toBe('ログイン直後の画面が空になる問題を直しています。');
    expect(statusFirstSentence('修复登录后白屏的问题！正在跑测试。')).toBe(
      '修复登录后白屏的问题！'
    );
  });

  it('clips a summary without sentence punctuation', () => {
    expect(statusFirstSentence('가'.repeat(100))).toBe(`${'가'.repeat(80)}…`);
    expect(statusFirstSentence('short')).toBe('short');
  });
});

describe('statusParagraphs', () => {
  it('splits paragraphs on blank lines and tokenizes links', () => {
    const text =
      '첫 문단 [메모](notes/a.html "vibe-artifact")와 [이슈](https://x.y/1)로.\n이어짐\n\n둘째 문단.';
    expect(statusPlainText(text)).toBe(
      '첫 문단 메모와 이슈로.\n이어짐\n\n둘째 문단.'
    );
    expect(statusParagraphs(text)).toEqual([
      [
        { kind: 'text', text: '첫 문단 ' },
        { kind: 'link', label: '메모', target: 'notes/a.html', artifact: true },
        { kind: 'text', text: '와 ' },
        {
          kind: 'link',
          label: '이슈',
          target: 'https://x.y/1',
          artifact: false,
        },
        { kind: 'text', text: '로. 이어짐' },
      ],
      [{ kind: 'text', text: '둘째 문단.' }],
    ]);
  });
});
