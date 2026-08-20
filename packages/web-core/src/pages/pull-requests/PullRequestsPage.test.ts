import { describe, expect, it } from 'vitest';
import { getPullRequestsDefaultLayout } from './PullRequestsPage';

describe('getPullRequestsDefaultLayout', () => {
  it('gives the list the full width when no details panel is rendered', () => {
    expect(getPullRequestsDefaultLayout(100, false)).toEqual({
      'pull-requests-list': 100,
    });
  });
});
