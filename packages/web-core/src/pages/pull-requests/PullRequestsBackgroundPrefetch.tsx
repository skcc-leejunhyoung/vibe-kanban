import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { pullRequestSummariesQueryOptions } from './pullRequestSummariesQuery';
import { syncTrackedGitHubPullRequests } from '@/shared/lib/remoteApi';

const TRACKED_PULL_REQUEST_SYNC_INTERVAL_MS = 5 * 60_000;

/** Keeps the configured Pull Requests view warm while the user works elsewhere. */
export function PullRequestsBackgroundPrefetch() {
  const queryClient = useQueryClient();
  const { isSignedIn, userId } = useAuth();
  const defaultFilters = useUiPreferencesStore(
    (state) => state.pullRequestDefaultFilters
  );

  const repositoriesKey = defaultFilters.repositories.join(',');

  useEffect(() => {
    if (!isSignedIn) return;
    const sync = () => {
      if (document.visibilityState === 'hidden') return;
      void syncTrackedGitHubPullRequests().catch(() => {
        // Best-effort background refresh; the Pull Requests page surfaces
        // actionable authentication, permission, and rate-limit failures.
      });
    };
    const initialTimer = window.setTimeout(sync, 200);
    const interval = window.setInterval(
      sync,
      TRACKED_PULL_REQUEST_SYNC_INTERVAL_MS
    );
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [isSignedIn]);

  useEffect(() => {
    if (!isSignedIn || defaultFilters.repositories.length === 0) return;

    const timer = window.setTimeout(() => {
      for (const repository of defaultFilters.repositories) {
        void queryClient.prefetchQuery(
          pullRequestSummariesQueryOptions(
            userId,
            repository,
            defaultFilters.involvesMe
          )
        );
      }
    }, 200);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    defaultFilters.involvesMe,
    isSignedIn,
    repositoriesKey,
    queryClient,
    userId,
  ]);

  return null;
}
