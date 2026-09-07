import { describe, expect, it } from 'vitest';
import {
  getPullRequestNumberFromUrl,
  getRepositoryFullNameFromPrUrl,
  isGitHubRepositoryFullName,
  normalizeGitHubPullRequestUrl,
} from './pullRequestUrl';

describe('pull request URL parsing', () => {
  it('parses repository name and PR number from GitHub URLs', () => {
    const url = 'https://github.com/acme/widgets/pull/42';

    expect(getRepositoryFullNameFromPrUrl(url)).toBe('acme/widgets');
    expect(getPullRequestNumberFromUrl(url)).toBe(42);
  });

  it('normalizes query-bearing and fragment-bearing deep links', () => {
    expect(
      normalizeGitHubPullRequestUrl(
        'https://github.com/acme/widgets/pull/42/?notification_referrer_id=1#discussion'
      )
    ).toBe('https://github.com/acme/widgets/pull/42');
  });

  it('recognizes canonical repository full names, not legacy host repo ids', () => {
    expect(isGitHubRepositoryFullName('acme/widgets')).toBe(true);
    expect(
      isGitHubRepositoryFullName('acb1d80f-9fe8-4415-a4b1-2d94134b2b10')
    ).toBe(false);
  });

  it('rejects malformed or non-PR URLs', () => {
    expect(getRepositoryFullNameFromPrUrl('not a URL')).toBeNull();
    expect(
      getRepositoryFullNameFromPrUrl(
        'https://github.example.com/acme/widgets/pull/42'
      )
    ).toBeNull();
    expect(
      getPullRequestNumberFromUrl('https://github.com/acme/widgets/issues/42')
    ).toBeNull();
    expect(
      getPullRequestNumberFromUrl(
        'https://github.com/acme/widgets/pull/not-a-number'
      )
    ).toBeNull();
    expect(
      getRepositoryFullNameFromPrUrl(
        'https://github.com:444/acme/widgets/pull/42'
      )
    ).toBeNull();
    expect(normalizeGitHubPullRequestUrl('not a URL')).toBeNull();
  });
});
