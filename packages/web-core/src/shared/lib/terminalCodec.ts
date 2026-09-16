/**
 * Wire codec for the terminal WebSocket. The PTY is a byte stream and the
 * transport frames it at arbitrary offsets, so output has to stay bytes until
 * xterm — whose decoder carries partial UTF-8 sequences across writes — gets
 * hold of it. Decoding per frame here would turn every multi-byte character
 * that straddles a frame boundary into U+FFFD.
 */

/** Keystrokes → base64 UTF-8, which is what the PTY expects on stdin. */
export function encodeTerminalInput(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const binString = Array.from(bytes, (b) => String.fromCodePoint(b)).join('');
  return btoa(binString);
}

/** One base64 output frame → its exact bytes. Never a string. */
export function decodeTerminalOutput(base64: string): Uint8Array {
  const binString = atob(base64);
  return Uint8Array.from(binString, (c) => c.codePointAt(0)!);
}
