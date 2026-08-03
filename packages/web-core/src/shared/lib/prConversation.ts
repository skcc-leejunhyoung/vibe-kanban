import type {
  PullRequestCommit,
  PullRequestDetail,
  PullRequestReview,
  UnifiedPrComment,
} from 'shared/types';

export type PrCommentThread = {
  comment: UnifiedPrComment;
  replies: PrCommentThread[];
};

export type PrConversationItem =
  | {
      kind: 'status';
      key: string;
      action: 'opened' | 'closed' | 'merged';
      actor: string | null;
      createdAt: string;
    }
  | {
      kind: 'commit';
      key: string;
      commit: PullRequestCommit;
      createdAt: string;
    }
  | {
      kind: 'review';
      key: string;
      review: PullRequestReview;
      createdAt: string;
    }
  | {
      kind: 'comment';
      key: string;
      thread: PrCommentThread;
      createdAt: string;
    };

export type PrReviewActivityTone = 'approved' | 'review-requested' | 'default';

export function isReviewRequestText(value: string): boolean {
  return /\b(?:re-?requested|requested) a review from\b/i.test(value);
}

export function getPrReviewActivityTone(
  review: PullRequestReview
): PrReviewActivityTone {
  const state = review.state.toUpperCase().replaceAll('-', '_');
  if (state === 'APPROVED') return 'approved';
  if (
    [
      'REQUESTED',
      'RE_REQUESTED',
      'REREQUESTED',
      'REVIEW_REQUESTED',
      'REVIEW_REREQUESTED',
    ].includes(state) ||
    isReviewRequestText(review.body)
  ) {
    return 'review-requested';
  }
  return 'default';
}

function buildCommentThreads(comments: UnifiedPrComment[]): PrCommentThread[] {
  const nodes = new Map<string, PrCommentThread>();
  comments.forEach((comment) =>
    nodes.set(comment.id, { comment, replies: [] })
  );

  const roots: PrCommentThread[] = [];
  comments.forEach((comment) => {
    const node = nodes.get(comment.id)!;
    const parent = comment.parent_id ? nodes.get(comment.parent_id) : undefined;
    if (parent && parent !== node) {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  });

  const sortThreads = (threads: PrCommentThread[]) => {
    threads.sort((a, b) =>
      a.comment.created_at.localeCompare(b.comment.created_at)
    );
    threads.forEach((thread) => sortThreads(thread.replies));
  };
  sortThreads(roots);
  return roots;
}

export function buildPrConversation(
  detail: PullRequestDetail,
  comments: UnifiedPrComment[]
): PrConversationItem[] {
  const fallbackDate = detail.created_at ?? detail.updated_at ?? '';
  const items: PrConversationItem[] = [];

  if (detail.created_at) {
    items.push({
      kind: 'status',
      key: 'status-opened',
      action: 'opened',
      actor: detail.author,
      createdAt: detail.created_at,
    });
  }

  detail.commits.forEach((commit) => {
    items.push({
      kind: 'commit',
      key: `commit-${commit.oid}`,
      commit,
      createdAt: commit.committed_at ?? fallbackDate,
    });
  });

  detail.reviews.forEach((review, index) => {
    // Some providers expose only the reviewer's current vote, without the
    // time that vote was submitted. Do not invent a position in the timeline
    // for those snapshots.
    if (!review.submitted_at) return;
    if (review.state.toUpperCase() === 'COMMENTED' && !review.body.trim()) {
      return;
    }

    items.push({
      kind: 'review',
      key: `review-${review.id || `${review.author}-${index}`}`,
      review,
      createdAt: review.submitted_at,
    });
  });

  buildCommentThreads(comments).forEach((thread) => {
    items.push({
      kind: 'comment',
      key: `comment-${thread.comment.id}`,
      thread,
      createdAt: thread.comment.created_at,
    });
  });

  if (detail.status === 'merged' && detail.merged_at) {
    items.push({
      kind: 'status',
      key: 'status-merged',
      action: 'merged',
      actor: null,
      createdAt: detail.merged_at,
    });
  } else if (detail.status === 'closed' && detail.updated_at) {
    items.push({
      kind: 'status',
      key: 'status-closed',
      action: 'closed',
      actor: null,
      createdAt: detail.updated_at,
    });
  }

  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
