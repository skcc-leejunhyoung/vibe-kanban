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

/**
 * Render a server-side failure (a shell that would not spawn, a missing
 * directory) into the terminal — there is no other surface for it, so without
 * this the panel just sits blank. The message crosses a trust boundary into an
 * ANSI interpreter, so its own control bytes are neutralised first.
 */
export function formatTerminalError(message: string): Uint8Array {
  const safe = message.replace(/[\x00-\x1f\x7f]/g, ' ');
  return new TextEncoder().encode(`\r\n\x1b[31m${safe}\x1b[0m\r\n`);
}
