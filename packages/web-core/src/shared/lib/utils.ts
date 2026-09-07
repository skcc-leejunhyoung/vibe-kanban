import { type ClassValue, clsx } from 'clsx';
import type { SoundFile } from 'shared/types';
// import { twMerge } from 'tailwind-merge';

const AUDIO_RESUME_TIMEOUT_MS = 1_000;
const AUDIO_PLAYBACK_GRACE_MS = 1_000;

function withAudioTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(
      () => reject(new Error('Audio playback timed out')),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

export function cn(...inputs: ClassValue[]) {
  // TODO: Re-enable twMerge after migration to tailwind v4
  // Doesn't support de-duplicating custom classes, eg text-brand and text-base
  // return twMerge(clsx(inputs));
  return clsx(inputs);
}

/**
 * Play a sound without registering as media playback, which can interrupt
 * music through the browser or macOS NowPlaying / MediaRemote.
 */
export async function playSound(soundFile: SoundFile): Promise<void> {
  const url = new URL(
    `../../../../../assets/sounds/${soundFile.toLowerCase().replaceAll('_', '-')}.wav`,
    import.meta.url
  ).href;

  const ctx = new AudioContext();
  try {
    await withAudioTimeout(ctx.resume(), AUDIO_RESUME_TIMEOUT_MS);
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(ctx.destination);
    await withAudioTimeout(
      new Promise<void>((resolve) => {
        src.onended = () => resolve();
        src.start();
      }),
      audio.duration * 1_000 + AUDIO_PLAYBACK_GRACE_MS
    );
  } finally {
    await ctx.close();
  }
}

export function formatFileSize(bytes: bigint | null | undefined): string {
  if (!bytes) return '';
  const num = Number(bytes);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}
