import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PULL_REQUEST_FILTER_STATE,
  resolvePullRequestFiltersAfterDefaultsChange,
} from './pullRequestFilters';

describe('DEFAULT_PULL_REQUEST_FILTER_STATE', () => {
  it('does not limit pull requests to the current user by default', () => {
    expect(DEFAULT_PULL_REQUEST_FILTER_STATE.involvesMe).toBe(false);
  });
});

describe('resolvePullRequestFiltersAfterDefaultsChange', () => {
  it('applies defaults loaded after the page mounted', () => {
    const loadedDefaults = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      status: 'open' as const,
      involvesMe: true,
    };

    expect(
      resolvePullRequestFiltersAfterDefaultsChange(
        { ...DEFAULT_PULL_REQUEST_FILTER_STATE },
        DEFAULT_PULL_REQUEST_FILTER_STATE,
        loadedDefaults
      )
    ).toEqual(loadedDefaults);
  });

  it('preserves filters that the user already changed', () => {
    const current = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      status: 'merged' as const,
    };
    const loadedDefaults = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      status: 'open' as const,
    };

    expect(
      resolvePullRequestFiltersAfterDefaultsChange(
        current,
        DEFAULT_PULL_REQUEST_FILTER_STATE,
        loadedDefaults
      )
    ).toBe(current);
  });
});
