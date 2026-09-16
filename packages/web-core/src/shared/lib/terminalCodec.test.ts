import { describe, expect, it } from 'vitest';
import {
  decodeTerminalOutput,
  encodeTerminalInput,
} from '@/shared/lib/terminalCodec';

const toBase64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCodePoint(b)).join(''));

describe('terminal wire codec', () => {
  it('round-trips keystrokes as UTF-8', () => {
    const base64 = encodeTerminalInput('한글 ✓');
    expect(new TextDecoder().decode(decodeTerminalOutput(base64))).toBe(
      '한글 ✓'
    );
  });

  it('keeps a character split across two frames intact', () => {
    // The PTY chunks its reads at arbitrary byte offsets, so a 3-byte Hangul
    // syllable routinely lands half in one frame and half in the next. Decoding
    // each frame on its own would yield U+FFFD on both sides; handing the raw
    // bytes to xterm's streaming decoder does not.
    const full = new TextEncoder().encode('디렉터리');
    const split = 5; // mid-character
    const frames = [full.subarray(0, split), full.subarray(split)];

    const received = frames.flatMap((frame) => [
      ...decodeTerminalOutput(toBase64(frame)),
    ]);
    expect(new Uint8Array(received)).toEqual(full);
    expect(new TextDecoder().decode(new Uint8Array(received))).toBe('디렉터리');

    // The old behaviour, pinned so it cannot quietly come back.
    const perFrame = frames
      .map((frame) => new TextDecoder().decode(frame))
      .join('');
    expect(perFrame).toContain('�');
  });
});
