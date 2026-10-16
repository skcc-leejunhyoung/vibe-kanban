import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REQUEST_TIMEOUT_MS, withRequestTimeout } from './withRequestTimeout';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('releases a stalled read even if token lookup or parsing ignores abort', async () => {
  let signal!: AbortSignal;
  const result = withRequestTimeout((requestSignal) => {
    signal = requestSignal;
    return new Promise(() => {});
  });
  const failed = expect(result).rejects.toThrow('Request timed out');
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  await failed;
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('propagates cancellation and removes its timeout', async () => {
  const controller = new AbortController();
  const result = withRequestTimeout(
    () => new Promise(() => {}),
    controller.signal
  );
  const failed = expect(result).rejects.toThrow('Cancelled');
  controller.abort(new Error('Cancelled'));
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});

it('does not start a cancelled read and clears successful read timers', async () => {
  const request = vi.fn(async () => 'fresh');
  await expect(
    withRequestTimeout(request, AbortSignal.abort(new Error('Cancelled')))
  ).rejects.toThrow('Cancelled');
  expect(request).not.toHaveBeenCalled();
  await expect(withRequestTimeout(request)).resolves.toBe('fresh');
  expect(vi.getTimerCount()).toBe(0);
});
