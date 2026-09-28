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

/**
 * Header note for a conversation turn: "10:30 → 10:42 · 12m 3s" once the
 * agent finished, "10:30 → … · 3m 12s" while it is still running (`now` is
 * the ticking clock). `title` carries the full dates for the tooltip.
 */
export function formatTurnTiming(
  startedAt: string,
  completedAt: string | null,
  now: number | null
): { text: string; title: string } | null {
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return null;
  const end = completedAt ? new Date(completedAt).getTime() : now;
  if (end == null || Number.isNaN(end)) {
    return {
      text: formatClock(startedAt),
      title: formatDateShortWithTime(startedAt),
    };
  }
  const elapsed = formatElapsed(end - start);
  return completedAt
    ? {
        text: `${formatClock(startedAt)} → ${formatClock(completedAt)} · ${elapsed}`,
        title: `${formatDateShortWithTime(startedAt)} → ${formatDateShortWithTime(completedAt)}`,
      }
    : {
        text: `${formatClock(startedAt)} → … · ${elapsed}`,
        title: formatDateShortWithTime(startedAt),
      };
}
