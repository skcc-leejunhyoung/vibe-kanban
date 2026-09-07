import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoundFile } from 'shared/types';
import { playSound } from './utils';

describe('playSound', () => {
  afterEach(() => {
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
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => ({
        close,
        createBufferSource: () => source,
        decodeAudioData: vi.fn(async () => ({})),
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
    expect(audioElement).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
