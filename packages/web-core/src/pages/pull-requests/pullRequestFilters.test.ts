import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PULL_REQUEST_FILTER_STATE,
  resolvePullRequestFiltersAfterDefaultsChange,
  resolvePullRequestFiltersAfterRepositoriesChange,
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

  it('restores configured defaults after filters reset to empty', () => {
    const configuredDefaults = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      repositories: ['repo-1'],
      status: 'open' as const,
      involvesMe: true,
    };

    expect(
      resolvePullRequestFiltersAfterDefaultsChange(
        { ...DEFAULT_PULL_REQUEST_FILTER_STATE },
        configuredDefaults,
        configuredDefaults
      )
    ).toEqual(configuredDefaults);
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

  it('applies the default repositories when none are selected yet', () => {
    const previousDefaults = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      status: 'open' as const,
      repositories: [],
    };
    const nextDefaults = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      status: 'open' as const,
      repositories: ['repo-1'],
    };
    // Fresh open with nothing selected yet: the saved default repos apply even
    // when they load after mount.
    const untouched = { ...previousDefaults, repositories: [] };

    expect(
      resolvePullRequestFiltersAfterDefaultsChange(
        untouched,
        previousDefaults,
        nextDefaults
      )
    ).toEqual(nextDefaults);
  });

  it('applies new defaults while preserving the current repository picks', () => {
    const previousDefaults = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      status: 'open' as const,
      repositories: ['repo-1'],
    };
    const nextDefaults = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      status: 'merged' as const,
      repositories: ['repo-2'],
    };
    // A repo auto-selected by a deep link is not a manual refinement edit, so
    // the freshly loaded defaults still apply — but the current repos survive.
    const onlyReposChanged = {
      ...previousDefaults,
      repositories: ['repo-1', 'repo-3'],
    };

    expect(
      resolvePullRequestFiltersAfterDefaultsChange(
        onlyReposChanged,
        previousDefaults,
        nextDefaults
      )
    ).toEqual({ ...nextDefaults, repositories: ['repo-1', 'repo-3'] });
  });

  it('preserves state when a refinement filter was changed', () => {
    const previousDefaults = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      status: 'open' as const,
    };
    const nextDefaults = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      status: 'merged' as const,
    };
    const refinementChanged = {
      ...previousDefaults,
      status: 'closed' as const,
    };

    expect(
      resolvePullRequestFiltersAfterDefaultsChange(
        refinementChanged,
        previousDefaults,
        nextDefaults
      )
    ).toBe(refinementChanged);
  });
});

describe('resolvePullRequestFiltersAfterRepositoriesChange', () => {
  it('restores valid configured defaults after repository pruning empties filters', () => {
    const defaults = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      repositories: ['repo-1'],
    };

    expect(
      resolvePullRequestFiltersAfterRepositoriesChange(
        { ...DEFAULT_PULL_REQUEST_FILTER_STATE },
        defaults,
        new Set(['repo-1'])
      )
    ).toEqual(defaults);
  });

  it('does not restore a deleted default repository', () => {
    const defaults = {
      ...DEFAULT_PULL_REQUEST_FILTER_STATE,
      repositories: ['repo-1'],
    };

    expect(
      resolvePullRequestFiltersAfterRepositoriesChange(
        defaults,
        defaults,
        new Set<string>()
      )
    ).toEqual(DEFAULT_PULL_REQUEST_FILTER_STATE);
  });
});
