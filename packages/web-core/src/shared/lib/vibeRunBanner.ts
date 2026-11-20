import type { VibeReviewStatus } from 'shared/types';

export type VibeRunTone = 'progress' | 'blocked' | 'done';

export interface VibeRunBanner {
  tone: VibeRunTone;
  /** `tasks` i18n key of the headline. */
  messageKey: string;
  /** The server's own reason (git or PR host output), shown as it is. */
  detail: string | null;
  /** A retry resumes the step that failed; it never reviews again. */
  canRetry: boolean;
  /** When a waiting merge is tried again by itself. */
  retryAt: string | null;
}

/** How long an outcome nobody has to act on stays on screen. */
const SETTLED_VISIBLE_MS = 24 * 60 * 60 * 1000;

function banner(
  tone: VibeRunTone,
  messageKey: string,
  extra: Partial<VibeRunBanner> = {}
): VibeRunBanner {
  return {
    tone,
    messageKey,
    detail: null,
    canRetry: false,
    retryAt: null,
    ...extra,
  };
}

/**
 * What to show for the workspace's vibe run, from the server's state alone:
 * the automation worker drives the review → merge → push → PR workflow, and
 * this only says where it stands. `null` shows nothing — a run that is coding
 * or under a plain review speaks for itself in the conversation.
 */
export function vibeRunBanner(
  status: VibeReviewStatus | null | undefined,
  now: number = Date.now()
): VibeRunBanner | null {
  if (!status?.phase) return null;
  const detail = status.last_error ?? null;
  const settledRecently =
    !!status.updated_at &&
    now - Date.parse(status.updated_at) < SETTLED_VISIBLE_MS;

  // The run reported something the automation worker has not acted on yet:
  // it moves again once the worker takes the next step.
  if (status.pending_kind) {
    if (
      status.pending_kind === 'vibe.turn_ended' &&
      status.pending_outcome === 'approve'
    ) {
      return banner('progress', 'conversation.vibeRun.approvedWaiting');
    }
    if (status.phase !== 'blocked') {
      return banner('progress', 'conversation.vibeRun.automationWaiting', {
        detail,
      });
    }
  }

  switch (status.phase) {
    case 'review':
      return status.pr_requested
        ? banner('progress', 'conversation.vibeRun.reviewing')
        : null;
    case 'merging':
      // A merge in flight takes a moment; one waiting on a failure is retried
      // on a schedule and is worth showing for any run.
      if (detail) {
        return banner('progress', 'conversation.vibeRun.mergeWaiting', {
          detail,
          canRetry: true,
          retryAt: status.merge_retry_at ?? null,
        });
      }
      return status.pr_requested
        ? banner('progress', 'conversation.vibeRun.merging')
        : null;
    case 'pushing':
      return banner('progress', 'conversation.vibeRun.pushing');
    case 'creating_pr':
      return banner('progress', 'conversation.vibeRun.creatingPr');
    case 'blocked':
      if (status.failed_phase === 'pushing') {
        return banner('blocked', 'conversation.vibeRun.pushFailed', {
          detail,
          canRetry: true,
        });
      }
      if (status.failed_phase === 'creating_pr') {
        return banner('blocked', 'conversation.vibeRun.prFailed', {
          detail,
          canRetry: true,
        });
      }
      if (detail) {
        // A run that owes its PR shows the failed merge until someone acts on
        // it. For a plain review it is news for a day: the issue comment and
        // the notification said it, and a merge later done by hand leaves the
        // run as it was.
        return status.pr_requested || settledRecently
          ? banner('blocked', 'conversation.vibeRun.mergeFailed', {
              detail,
              canRetry: true,
            })
          : null;
      }
      // Blocked by the review itself: nothing to retry, and for a plain review
      // nothing new to say.
      return status.pr_requested && settledRecently
        ? banner('blocked', 'conversation.vibeRun.reviewBlocked')
        : null;
    case 'done':
      return status.pr_requested && settledRecently
        ? banner('done', 'conversation.vibeRun.done')
        : null;
    default:
      return null;
  }
}
