import type { PatchType } from 'shared/types';

export type LogStreamEntry = Extract<
  PatchType,
  { type: 'STDOUT' } | { type: 'STDERR' }
>;

/**
 * Ring-buffer ceiling for a single process log stream. A chatty dev server can
 * emit hundreds of thousands of lines; keeping them all pins memory and makes
 * every append copy a huge array.
 */
export const MAX_LOG_LINES = 10_000;

export interface LogBufferState {
  logs: LogStreamEntry[];
  /** Lines trimmed off the front since the stream (re)started. */
  dropped: number;
}

export const EMPTY_LOG_BUFFER: LogBufferState = { logs: [], dropped: 0 };

/**
 * Append a batch of lines, trimming the oldest past `MAX_LOG_LINES`.
 *
 * `replace` is the reconnect case: the server replays history, so the batch
 * supersedes what we already had instead of duplicating it.
 * `alreadyDropped` counts lines the caller discarded before they ever reached
 * the buffer (a hidden tab can queue more than the ceiling between frames).
 */
export function appendLogBatch(
  previous: LogBufferState,
  batch: LogStreamEntry[],
  { replace = false, alreadyDropped = 0 } = {}
): LogBufferState {
  if (batch.length === 0 && alreadyDropped === 0) return previous;
  const base = replace ? EMPTY_LOG_BUFFER : previous;
  const merged = base.logs.length === 0 ? batch : base.logs.concat(batch);
  const overflow = Math.max(0, merged.length - MAX_LOG_LINES);
  return {
    logs: overflow === 0 ? merged : merged.slice(overflow),
    dropped: base.dropped + alreadyDropped + overflow,
  };
}
