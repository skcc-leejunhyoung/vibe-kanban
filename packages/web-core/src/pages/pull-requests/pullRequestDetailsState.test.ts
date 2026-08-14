import { describe, expect, it } from 'vitest';
import { shouldPreservePullRequestDetails } from './pullRequestDetailsState';

describe('shouldPreservePullRequestDetails', () => {
  it('keeps a notification deep-link open while repository filters sync', () => {
    expect(
      shouldPreservePullRequestDetails(
        'https://github.com/acme/repo/pull/42',
        false
      )
    ).toBe(true);
  });
});
