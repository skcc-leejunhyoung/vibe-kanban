import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoundFile } from 'shared/types';
import { playSound } from './utils';

describe('playSound', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses Web Audio without claiming browser media playback', async () => {
    const source = {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      onended: null as (() => void) | null,
    };
    source.start.mockImplementation(() =>
      queueMicrotask(() => source.onended?.())
    );

    const close = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => ({
        close,
        resume,
        createBufferSource: () => source,
        decodeAudioData: vi.fn(async () => ({ duration: 1 })),
        destination: {},
      }))
    );
    const audioElement = vi.fn();
    vi.stubGlobal('Audio', audioElement);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }))
    );

    await playSound(SoundFile.COW_MOOING);

    expect(source.start).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(audioElement).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the context when browser autoplay remains blocked', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => ({
        close,
        resume: vi.fn(() => new Promise<void>(() => {})),
      }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const playback = expect(playSound(SoundFile.COW_MOOING)).rejects.toThrow(
      'Audio playback timed out'
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await playback;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the context when a started sound never ends', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const source = {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      onended: null as (() => void) | null,
    };
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => ({
        close,
        resume: vi.fn(async () => undefined),
        createBufferSource: () => source,
        decodeAudioData: vi.fn(async () => ({ duration: 0 })),
        destination: {},
      }))
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }))
    );

    const playback = expect(playSound(SoundFile.COW_MOOING)).rejects.toThrow(
      'Audio playback timed out'
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await playback;
    expect(source.start).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
