import type { PatchType } from 'shared/types';

export type LogStreamEntry = Extract<
  PatchType,
  { type: 'STDOUT' } | { type: 'STDERR' }
>;

/**
 * Ring-buffer ceilings for a single process log stream.
 *
 * Both are needed. One entry is not one line: the server wraps whatever
 * `ReaderStream` hands it (`decoded_log_stream` in local-deployment), so an
 * entry is an I/O chunk of up to ~4KB. A count ceiling alone would therefore
 * bound the array but not the memory — a build spewing full chunks would still
 * pin tens of megabytes per panel.
 */
export const MAX_LOG_ENTRIES = 10_000;
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

export interface LogBufferState {
  logs: LogStreamEntry[];
  /** Approximate size of `logs`, mirroring the server's `approx_bytes`. */
  bytes: number;
  /** Entries trimmed off the front since the stream (re)started. */
  dropped: number;
}

export const EMPTY_LOG_BUFFER: LogBufferState = {
  logs: [],
  bytes: 0,
  dropped: 0,
};

/**
 * Drop entries off the front until both ceilings hold — one pass, one slice,
 * so trimming never degrades into a shift per entry.
 */
export function trimLogBuffer(
  logs: LogStreamEntry[],
  bytes: number
): { logs: LogStreamEntry[]; bytes: number; trimmed: number } {
  let trimmed = Math.max(0, logs.length - MAX_LOG_ENTRIES);
  let remaining = bytes;
  for (let i = 0; i < trimmed; i += 1) remaining -= logs[i].content.length;
  while (remaining > MAX_LOG_BYTES && trimmed < logs.length) {
    remaining -= logs[trimmed].content.length;
    trimmed += 1;
  }
  return {
    logs: trimmed === 0 ? logs : logs.slice(trimmed),
    bytes: remaining,
    trimmed,
  };
}

/**
 * Append a batch of entries, trimming the oldest past the ceilings.
 *
 * `replace` is the reconnect case: the server replays history, so the batch
 * supersedes what we already had instead of duplicating it.
 * `alreadyDropped` counts entries the caller discarded before they reached the
 * buffer (a hidden tab can queue past the ceilings between frames).
 */
export function appendLogBatch(
  previous: LogBufferState,
  batch: LogStreamEntry[],
  { replace = false, alreadyDropped = 0 } = {}
): LogBufferState {
  if (batch.length === 0 && alreadyDropped === 0) return previous;
  const base = replace ? EMPTY_LOG_BUFFER : previous;
  const merged = base.logs.length === 0 ? batch : base.logs.concat(batch);
  let bytes = base.bytes;
  for (const entry of batch) bytes += entry.content.length;
  const trimmed = trimLogBuffer(merged, bytes);
  return {
    logs: trimmed.logs,
    bytes: trimmed.bytes,
    dropped: base.dropped + alreadyDropped + trimmed.trimmed,
  };
}
