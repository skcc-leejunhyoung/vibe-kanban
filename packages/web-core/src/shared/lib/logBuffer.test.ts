import { describe, expect, it } from 'vitest';
import {
  appendLogBatch,
  EMPTY_LOG_BUFFER,
  MAX_LOG_LINES,
  type LogStreamEntry,
} from './logBuffer';

const lines = (from: number, count: number): LogStreamEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    type: 'STDOUT' as const,
    content: `line ${from + i}`,
  }));

describe('appendLogBatch', () => {
  it('appends a batch and keeps the previous reference when empty', () => {
    const first = appendLogBatch(EMPTY_LOG_BUFFER, lines(0, 3));
    expect(first.logs.map((l) => l.content)).toEqual([
      'line 0',
      'line 1',
      'line 2',
    ]);
    expect(first.dropped).toBe(0);
    expect(appendLogBatch(first, [])).toBe(first);
  });

  it('replaces instead of appending on reconnect replay', () => {
    const first = appendLogBatch(EMPTY_LOG_BUFFER, lines(0, 3));
    const replayed = appendLogBatch(first, lines(0, 2), { replace: true });
    expect(replayed.logs.map((l) => l.content)).toEqual(['line 0', 'line 1']);
    expect(replayed.dropped).toBe(0);
  });

  it('trims the oldest lines past the ceiling and counts them', () => {
    const full = appendLogBatch(EMPTY_LOG_BUFFER, lines(0, MAX_LOG_LINES));
    expect(full.logs).toHaveLength(MAX_LOG_LINES);
    expect(full.dropped).toBe(0);

    const overflowed = appendLogBatch(full, lines(MAX_LOG_LINES, 5));
    expect(overflowed.logs).toHaveLength(MAX_LOG_LINES);
    expect(overflowed.dropped).toBe(5);
    expect(overflowed.logs[0].content).toBe('line 5');
    expect(overflowed.logs[MAX_LOG_LINES - 1].content).toBe(
      `line ${MAX_LOG_LINES + 4}`
    );
  });

  it('folds in lines the caller discarded before they reached the buffer', () => {
    const state = appendLogBatch(EMPTY_LOG_BUFFER, lines(0, 2), {
      alreadyDropped: 7,
    });
    expect(state.dropped).toBe(7);
    expect(state.logs).toHaveLength(2);

    // dropped is an absolute count, so an index taken before the drop still
    // resolves: absolute 8 sits at array offset 1.
    expect(state.logs[8 - state.dropped].content).toBe('line 1');
  });
});
