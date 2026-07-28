import { describe, expect, it } from 'vitest';
import type { PullRequestDetail, UnifiedPrComment } from 'shared/types';
import { buildPrConversation } from './prConversation';

const detail: PullRequestDetail = {
  number: 12n,
  url: 'https://github.com/example/repo/pull/12',
  status: 'open',
  merged_at: null,
  merge_commit_sha: null,
  title: 'Conversation',
  body: '',
  author: 'author',
  assignees: [],
  reviewers: [],
  review_decision: null,
  is_draft: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-03T00:00:00Z',
  base_branch: 'develop',
  head_branch: 'feature',
  commits: [
    {
      oid: 'abcdef123456',
      message: 'Add conversation',
      authors: ['author'],
      committed_at: '2026-01-01T01:00:00Z',
    },
  ],
  reviews: [
    {
      id: 'review-1',
      author: 'reviewer',
      state: 'APPROVED',
      body: 'Looks good',
      submitted_at: '2026-01-02T00:00:00Z',
    },
  ],
};

const comments: UnifiedPrComment[] = [
  {
    comment_type: 'review',
    id: 'reply',
    author: 'author',
    author_association: 'CONTRIBUTOR',
    body: 'Fixed',
    created_at: '2026-01-02T02:00:00Z',
    url: null,
    path: 'src/file.ts',
    line: 4n,
    side: 'RIGHT',
    diff_hunk: null,
    parent_id: 'root',
    review_id: 'review-1',
  },
  {
    comment_type: 'review',
    id: 'root',
    author: 'reviewer',
    author_association: 'MEMBER',
    body: 'Please change this',
    created_at: '2026-01-02T01:00:00Z',
    url: null,
    path: 'src/file.ts',
    line: 4n,
    side: 'RIGHT',
    diff_hunk: null,
    parent_id: null,
    review_id: 'review-1',
  },
];

describe('buildPrConversation', () => {
  it('orders PR activity and nests review replies under their parent', () => {
    const conversation = buildPrConversation(detail, comments);

    expect(conversation.map((item) => item.kind)).toEqual([
      'status',
      'commit',
      'review',
      'comment',
    ]);
    const thread = conversation.find((item) => item.kind === 'comment');
    expect(thread?.kind === 'comment' && thread.thread.comment.id).toBe('root');
    expect(
      thread?.kind === 'comment' && thread.thread.replies[0]?.comment.id
    ).toBe('reply');
  });

  it('omits provider review snapshots that have no activity timestamp', () => {
    const conversation = buildPrConversation(
      {
        ...detail,
        reviews: [
          {
            id: '',
            author: 'azure-reviewer',
            state: 'APPROVED',
            body: '',
            submitted_at: null,
          },
        ],
      },
      []
    );

    expect(conversation.some((item) => item.kind === 'review')).toBe(false);
  });
});
