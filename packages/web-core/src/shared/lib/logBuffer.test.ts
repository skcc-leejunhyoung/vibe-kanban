import { describe, expect, it } from 'vitest';
import {
  appendLogBatch,
  EMPTY_LOG_BUFFER,
  MAX_LOG_BYTES,
  MAX_LOG_ENTRIES,
  trimLogBuffer,
  type LogStreamEntry,
} from './logBuffer';

const lines = (from: number, count: number): LogStreamEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    type: 'STDOUT' as const,
    content: `line ${from + i}`,
  }));

const chunks = (count: number, size: number): LogStreamEntry[] =>
  Array.from({ length: count }, () => ({
    type: 'STDOUT' as const,
    content: 'x'.repeat(size),
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
    expect(first.bytes).toBe('line 0line 1line 2'.length);
    expect(appendLogBatch(first, [])).toBe(first);
  });

  it('replaces instead of appending on reconnect replay', () => {
    const first = appendLogBatch(EMPTY_LOG_BUFFER, lines(0, 3));
    const replayed = appendLogBatch(first, lines(0, 2), { replace: true });
    expect(replayed.logs.map((l) => l.content)).toEqual(['line 0', 'line 1']);
    expect(replayed.dropped).toBe(0);
    expect(replayed.bytes).toBe('line 0line 1'.length);
  });

  it('trims the oldest entries past the count ceiling and counts them', () => {
    const full = appendLogBatch(EMPTY_LOG_BUFFER, lines(0, MAX_LOG_ENTRIES));
    expect(full.logs).toHaveLength(MAX_LOG_ENTRIES);
    expect(full.dropped).toBe(0);

    const overflowed = appendLogBatch(full, lines(MAX_LOG_ENTRIES, 5));
    expect(overflowed.logs).toHaveLength(MAX_LOG_ENTRIES);
    expect(overflowed.dropped).toBe(5);
    expect(overflowed.logs[0].content).toBe('line 5');
    expect(overflowed.logs[MAX_LOG_ENTRIES - 1].content).toBe(
      `line ${MAX_LOG_ENTRIES + 4}`
    );
  });

  it('bounds memory even when far under the count ceiling', () => {
    // An entry is an I/O chunk, not a line: 2000 x 4KB stays under
    // MAX_LOG_ENTRIES but is 8MB, so only the byte ceiling can catch it.
    const chunkSize = 4096;
    const count = 2 * Math.ceil(MAX_LOG_BYTES / chunkSize);
    const state = appendLogBatch(EMPTY_LOG_BUFFER, chunks(count, chunkSize));
    expect(state.logs.length).toBeLessThan(MAX_LOG_ENTRIES);
    expect(state.bytes).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(state.dropped).toBe(count - state.logs.length);
    expect(state.bytes).toBe(state.logs.length * chunkSize);
  });

  it('folds in entries the caller discarded before they reached the buffer', () => {
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

describe('trimLogBuffer', () => {
  it('returns the same array when both ceilings already hold', () => {
    const logs = lines(0, 3);
    const result = trimLogBuffer(logs, 18);
    expect(result.logs).toBe(logs);
    expect(result.trimmed).toBe(0);
    expect(result.bytes).toBe(18);
  });
});
