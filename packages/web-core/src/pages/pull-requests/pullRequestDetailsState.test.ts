import { describe, expect, it } from 'vitest';
import { getPullRequestTargetFromUrl } from './pullRequestDetailsState';

describe('getPullRequestTargetFromUrl', () => {
  const url = 'https://github.com/acme/repo/pull/42';

  it('follows close, same-link reopen, PR change, and invalid-link navigation', () => {
    expect(
      [url, undefined, url, url.replace('/42', '/43'), 'invalid', url].map(
        getPullRequestTargetFromUrl
      )
    ).toEqual([
      { url, number: 42 },
      null,
      { url, number: 42 },
      { url: url.replace('/42', '/43'), number: 43 },
      null,
      { url, number: 42 },
    ]);
  });

  it('normalizes notification links without depending on repository filters', () => {
    expect(
      getPullRequestTargetFromUrl(`${url}?notification_referrer_id=1`)
    ).toEqual({ url, number: 42 });
  });
});
