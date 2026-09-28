import { formatElapsed, withDisplayTimeZone } from '@vibe/ui/lib/datetime';

/**
 * Format a date string as "Jan 5, 10:30 AM" in Korea Standard Time.
 */
export function formatDateShortWithTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString(
    undefined,
    withDisplayTimeZone({
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  );
}

/**
 * Format a date string as a relative time (e.g., "just now", "5m ago", "2h ago", "3d ago").
 */
export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function formatClock(dateString: string): string {
  return new Date(dateString).toLocaleTimeString(
    undefined,
    withDisplayTimeZone({
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
  );
}

/** Full date and time with seconds, e.g. "2026. 09. 28. 15:28:05" (KST). */
export function formatDateTimeFull(dateString: string): string {
  return new Date(dateString).toLocaleString(
    undefined,
    withDisplayTimeZone({
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
  );
}

export interface TurnTiming {
  /** Header note: "10:30 → 10:42 · 12m 3s", or "10:30 → … · 3m 12s" while running. */
  text: string;
  /** Full send / finish timestamps and elapsed for the hover detail. */
  sentAt: string;
  finishedAt: string | null;
  elapsed: string | null;
}

/**
 * Timing of a conversation turn. `now` is the ticking clock while the agent
 * is still running; pass `null` once `completedAt` is known.
 */
export function formatTurnTiming(
  startedAt: string,
  completedAt: string | null,
  now: number | null
): TurnTiming | null {
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return null;
  const end = completedAt ? new Date(completedAt).getTime() : now;
  const sentAt = formatDateTimeFull(startedAt);
  if (end == null || Number.isNaN(end)) {
    return {
      text: formatClock(startedAt),
      sentAt,
      finishedAt: null,
      elapsed: null,
    };
  }
  const elapsed = formatElapsed(end - start);
  return completedAt
    ? {
        text: `${formatClock(startedAt)} → ${formatClock(completedAt)} · ${elapsed}`,
        sentAt,
        finishedAt: formatDateTimeFull(completedAt),
        elapsed,
      }
    : {
        text: `${formatClock(startedAt)} → … · ${elapsed}`,
        sentAt,
        finishedAt: null,
        elapsed,
      };
}
