import { describe, expect, it } from 'vitest';
import {
  getPullRequestNumberFromUrl,
  getRepositoryNameFromPrUrl,
} from './pullRequestUrl';

describe('pull request URL parsing', () => {
  it('parses repository name and PR number from GitHub URLs', () => {
    const url = 'https://github.example.com/acme/widgets/pull/42';

    expect(getRepositoryNameFromPrUrl(url)).toBe('widgets');
    expect(getPullRequestNumberFromUrl(url)).toBe(42);
  });

  it('rejects malformed or non-PR URLs', () => {
    expect(getRepositoryNameFromPrUrl('not a URL')).toBeNull();
    expect(
      getPullRequestNumberFromUrl('https://github.com/acme/widgets/issues/42')
    ).toBeNull();
    expect(
      getPullRequestNumberFromUrl(
        'https://github.com/acme/widgets/pull/not-a-number'
      )
    ).toBeNull();
  });
});
