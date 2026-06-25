import { describe, expect, it } from 'vitest';
import type { Tag } from 'shared/remote-types';
import type { PullRequestDetail } from 'shared/types';

import {
  appendReviewInstruction,
  buildPrReviewInput,
  findOpenPrDetailForIssue,
  hasReviewTag,
  resolveReviewMode,
} from './reviewMode';

function tag(name: string): Tag {
  return { id: `t-${name}`, project_id: 'p1', name, color: '0 0% 0%' };
}

function prDetail(
  overrides: Partial<PullRequestDetail> = {}
): PullRequestDetail {
  return {
    number: 7n,
    url: 'https://github.com/o/r/pull/7',
    status: 'open',
    merged_at: null,
    merge_commit_sha: null,
    title: 'Add feature',
    base_branch: 'main',
    head_branch: 'feature-x',
    ...overrides,
  };
}

describe('hasReviewTag', () => {
  it('detects the review tag', () => {
    expect(hasReviewTag([tag('bug'), tag('review')])).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(hasReviewTag([tag('  Review ')])).toBe(true);
  });

  it('returns false without a review tag', () => {
    expect(hasReviewTag([tag('bug'), tag('feature')])).toBe(false);
  });

  it('returns false for empty tags', () => {
    expect(hasReviewTag([])).toBe(false);
  });
});

describe('findOpenPrDetailForIssue', () => {
  it('matches an open PR to one of the issue PR urls', () => {
    const a = prDetail({
      url: 'https://github.com/o/r/pull/1',
      head_branch: 'a',
    });
    const b = prDetail({
      url: 'https://github.com/o/r/pull/2',
      head_branch: 'b',
    });
    const found = findOpenPrDetailForIssue(
      [a, b],
      ['https://github.com/o/r/pull/2']
    );
    expect(found?.head_branch).toBe('b');
  });

  it('returns null when no open PR matches', () => {
    const a = prDetail({ url: 'https://github.com/o/r/pull/1' });
    expect(
      findOpenPrDetailForIssue([a], ['https://github.com/o/r/pull/9'])
    ).toBeNull();
  });
});

describe('buildPrReviewInput', () => {
  it('maps PR detail + repo + remote into the backend payload', () => {
    const input = buildPrReviewInput('repo-1', prDetail(), 'origin');
    expect(input).toEqual({
      repo_id: 'repo-1',
      pr_number: 7n,
      pr_title: 'Add feature',
      pr_url: 'https://github.com/o/r/pull/7',
      head_branch: 'feature-x',
      base_branch: 'main',
      remote_name: 'origin',
    });
  });

  it('allows a null remote', () => {
    expect(
      buildPrReviewInput('repo-1', prDetail(), null).remote_name
    ).toBeNull();
  });
});

describe('appendReviewInstruction', () => {
  it('appends the instruction below the prompt', () => {
    expect(appendReviewInstruction('Look at this')).toBe(
      'Look at this\n\nReview the checked-out PR.'
    );
  });

  it('trims trailing whitespace before appending', () => {
    expect(appendReviewInstruction('Look at this\n\n')).toBe(
      'Look at this\n\nReview the checked-out PR.'
    );
  });

  it('returns just the instruction for an empty prompt', () => {
    expect(appendReviewInstruction('   ')).toBe('Review the checked-out PR.');
  });
});

describe('resolveReviewMode', () => {
  it('returns the payload for a review issue with an open PR', () => {
    const result = resolveReviewMode({
      tags: [tag('review')],
      openPrs: [prDetail()],
      issuePrUrls: ['https://github.com/o/r/pull/7'],
      repoId: 'repo-1',
      remoteName: 'origin',
    });
    expect(result?.head_branch).toBe('feature-x');
    expect(result?.pr_number).toBe(7n);
  });

  it('returns null without the review tag', () => {
    expect(
      resolveReviewMode({
        tags: [tag('bug')],
        openPrs: [prDetail()],
        issuePrUrls: ['https://github.com/o/r/pull/7'],
        repoId: 'repo-1',
        remoteName: 'origin',
      })
    ).toBeNull();
  });

  it('returns null when the review issue has no matching open PR', () => {
    expect(
      resolveReviewMode({
        tags: [tag('review')],
        openPrs: [],
        issuePrUrls: ['https://github.com/o/r/pull/7'],
        repoId: 'repo-1',
        remoteName: 'origin',
      })
    ).toBeNull();
  });
});
