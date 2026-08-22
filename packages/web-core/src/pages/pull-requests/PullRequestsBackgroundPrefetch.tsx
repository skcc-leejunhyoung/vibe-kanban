import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { pullRequestSummariesQueryOptions } from './pullRequestSummariesQuery';
import { useHostId } from '@/shared/providers/HostIdProvider';

/** Keeps the configured Pull Requests view warm while the user works elsewhere. */
export function PullRequestsBackgroundPrefetch() {
  const queryClient = useQueryClient();
  const hostId = useHostId();
  const defaultFilters = useUiPreferencesStore(
    (state) => state.pullRequestDefaultFilters
  );

  const repositoriesKey = defaultFilters.repositories.join(',');

  useEffect(() => {
    if (defaultFilters.repositories.length === 0) return;

    const timer = window.setTimeout(() => {
      for (const repository of defaultFilters.repositories) {
        void queryClient.prefetchQuery(
          pullRequestSummariesQueryOptions(
            repository,
            defaultFilters.involvesMe,
            hostId
          )
        );
      }
    }, 200);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultFilters.involvesMe, hostId, repositoriesKey, queryClient]);

  return null;
}
