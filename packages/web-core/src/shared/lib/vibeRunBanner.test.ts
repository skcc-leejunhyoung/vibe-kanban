import { describe, expect, it } from 'vitest';
import type { VibeReviewStatus } from 'shared/types';
import { vibeRunBanner } from './vibeRunBanner';

const NOW = Date.parse('2026-11-12T12:00:00Z');

function status(overrides: Partial<VibeReviewStatus>): VibeReviewStatus {
  return {
    phase: null,
    last_error: null,
    merge_retry_at: null,
    pr_requested: true,
    failed_phase: null,
    updated_at: '2026-11-12T11:55:00Z',
    pending_kind: null,
    pending_outcome: null,
    ...overrides,
  };
}

const show = (overrides: Partial<VibeReviewStatus>) =>
  vibeRunBanner(status(overrides), NOW);

describe('vibeRunBanner', () => {
  it('shows a run waiting for the automation worker, an approval first', () => {
    // Approved; the worker has not started the merge yet (or is down).
    for (const phase of ['review', 'blocked']) {
      expect(
        show({
          phase,
          pr_requested: false,
          pending_kind: 'vibe.turn_ended',
          pending_outcome: 'approve',
        })
      ).toMatchObject({
        tone: 'progress',
        messageKey: 'conversation.vibeRun.approvedWaiting',
        canRetry: false,
      });
    }
    // Merged, and the worker is yet to finish it or open its PR.
    expect(
      show({
        phase: 'done',
        pr_requested: false,
        pending_kind: 'vibe.merge_result',
        pending_outcome: 'merged',
      })
    ).toMatchObject({ messageKey: 'conversation.vibeRun.automationWaiting' });
    // A merge failure waits for the worker to hand it on, with its reason.
    expect(
      show({
        phase: 'merging',
        last_error: 'repo: merge conflict',
        pending_kind: 'vibe.merge_result',
        pending_outcome: 'conflict',
      })
    ).toMatchObject({
      messageKey: 'conversation.vibeRun.automationWaiting',
      detail: 'repo: merge conflict',
      canRetry: false,
    });
    // A blocked step keeps its own banner and retry while the worker tags it.
    expect(
      show({
        phase: 'blocked',
        failed_phase: 'pushing',
        last_error: 'diverged',
        pending_kind: 'vibe.pr_result',
        pending_outcome: 'failed',
      })
    ).toMatchObject({
      messageKey: 'conversation.vibeRun.pushFailed',
      canRetry: true,
    });
  });

  it('shows each step of a review-and-create-PR run as the server reports it', () => {
    const steps = ['review', 'merging', 'pushing', 'creating_pr'].map((phase) =>
      show({ phase })
    );

    expect(steps.map((step) => step?.tone)).toEqual([
      'progress',
      'progress',
      'progress',
      'progress',
    ]);
    expect(steps.map((step) => step?.messageKey)).toEqual([
      'conversation.vibeRun.reviewing',
      'conversation.vibeRun.merging',
      'conversation.vibeRun.pushing',
      'conversation.vibeRun.creatingPr',
    ]);
    // Nothing to retry while the server is at work.
    expect(steps.every((step) => step?.canRetry === false)).toBe(true);
    expect(show({ phase: 'done' })).toMatchObject({
      tone: 'done',
      messageKey: 'conversation.vibeRun.done',
    });
  });

  it('names the failed step, gives its reason and offers the retry', () => {
    const reason =
      "widgets: pushing target branch 'feature' failed: the branch diverged";
    expect(
      show({ phase: 'blocked', failed_phase: 'pushing', last_error: reason })
    ).toEqual({
      tone: 'blocked',
      messageKey: 'conversation.vibeRun.pushFailed',
      detail: reason,
      canRetry: true,
      retryAt: null,
    });
    expect(
      show({
        phase: 'blocked',
        failed_phase: 'creating_pr',
        last_error: 'gh: not logged in',
      })
    ).toMatchObject({
      messageKey: 'conversation.vibeRun.prFailed',
      detail: 'gh: not logged in',
      canRetry: true,
    });
    // A failed merge has no follow-up step recorded.
    expect(
      show({ phase: 'blocked', last_error: 'repo: merge conflict' })
    ).toMatchObject({
      messageKey: 'conversation.vibeRun.mergeFailed',
      canRetry: true,
    });
  });

  it('shows a merge that waits to be retried, with its next try', () => {
    expect(
      show({
        phase: 'merging',
        pr_requested: false,
        last_error: "repo: 'main' checkout has uncommitted changes",
        merge_retry_at: '2026-11-12T12:05:00Z',
      })
    ).toMatchObject({
      tone: 'progress',
      messageKey: 'conversation.vibeRun.mergeWaiting',
      canRetry: true,
      retryAt: '2026-11-12T12:05:00Z',
    });
  });

  it('says a blocked review made no PR, with nothing to retry', () => {
    expect(show({ phase: 'blocked' })).toMatchObject({
      tone: 'blocked',
      messageKey: 'conversation.vibeRun.reviewBlocked',
      canRetry: false,
    });
  });

  it('stays out of the way of a plain review and of old outcomes', () => {
    for (const phase of ['coding', 'review', 'merging', 'done', 'blocked']) {
      expect(show({ phase, pr_requested: false })).toBeNull();
    }
    expect(show({ phase: 'coding' })).toBeNull();
    expect(show({ phase: null })).toBeNull();
    expect(vibeRunBanner(undefined, NOW)).toBeNull();
    // Settled more than a day ago: no longer news.
    const old = { updated_at: '2026-11-11T11:00:00Z' };
    expect(show({ phase: 'done', ...old })).toBeNull();
    expect(show({ phase: 'blocked', ...old })).toBeNull();
    // A failure waiting for its retry is shown however old it is.
    expect(
      show({
        phase: 'blocked',
        failed_phase: 'pushing',
        last_error: 'x',
        ...old,
      })
    ).not.toBeNull();
  });

  // A failed merge of a plain review is news for a day; one that still owes
  // its PR stays until someone retries it.
  it('lets go of an old failed merge unless the run still owes its PR', () => {
    const failed = { phase: 'blocked', last_error: 'repo: merge conflict' };
    const old = { updated_at: '2026-11-11T11:00:00Z' };

    expect(show({ ...failed, pr_requested: false })).toMatchObject({
      messageKey: 'conversation.vibeRun.mergeFailed',
      canRetry: true,
    });
    expect(show({ ...failed, pr_requested: false, ...old })).toBeNull();
    expect(show({ ...failed, pr_requested: true, ...old })).toMatchObject({
      messageKey: 'conversation.vibeRun.mergeFailed',
      canRetry: true,
    });
  });
});
