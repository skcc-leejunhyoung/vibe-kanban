import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { pullRequestSummariesQueryOptions } from './pullRequestSummariesQuery';

/** Keeps the configured Pull Requests view warm while the user works elsewhere. */
export function PullRequestsBackgroundPrefetch() {
  const queryClient = useQueryClient();
  const defaultFilters = useUiPreferencesStore(
    (state) => state.pullRequestDefaultFilters
  );

  useEffect(() => {
    if (defaultFilters.repository === 'all') return;

    const timer = window.setTimeout(() => {
      void queryClient.prefetchQuery(
        pullRequestSummariesQueryOptions(
          defaultFilters.repository,
          defaultFilters.involvesMe
        )
      );
    }, 200);

    return () => window.clearTimeout(timer);
  }, [defaultFilters.involvesMe, defaultFilters.repository, queryClient]);

  return null;
}
