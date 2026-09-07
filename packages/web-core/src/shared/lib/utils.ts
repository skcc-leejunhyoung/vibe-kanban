import { type ClassValue, clsx } from 'clsx';
import type { SoundFile } from 'shared/types';
// import { twMerge } from 'tailwind-merge';

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
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(ctx.destination);
    src.start();
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
    });
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
