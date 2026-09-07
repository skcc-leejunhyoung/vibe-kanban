import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FunnelIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { SettingsCard } from './SettingsComponents';
import { PullRequestFiltersDialog } from '@/pages/pull-requests/PullRequestFiltersDialog';
import {
  DEFAULT_PULL_REQUEST_FILTER_STATE,
  prunePullRequestRepositories,
} from '@/pages/pull-requests/pullRequestFilters';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { listGitHubRepositories } from '@/shared/lib/remoteApi';
import { GitHubApiErrorAlert } from '@/shared/components/GitHubApiErrorAlert';

export function PullRequestDefaultsSettings() {
  const { isSignedIn } = useAuth();
  const [open, setOpen] = useState(false);
  const filters = useUiPreferencesStore(
    (state) => state.pullRequestDefaultFilters
  );
  const setFilters = useUiPreferencesStore(
    (state) => state.setPullRequestDefaultFilters
  );
  const reposQuery = useQuery({
    queryKey: ['github-repositories'],
    queryFn: listGitHubRepositories,
    staleTime: 5 * 60_000,
    enabled: isSignedIn,
  });
  const repositories = useMemo(
    () =>
      (reposQuery.data ?? []).map((repo) => ({
        value: repo.full_name,
        label: repo.full_name,
      })),
    [reposQuery.data]
  );

  useEffect(() => {
    if (!reposQuery.isSuccess) return;
    const next = prunePullRequestRepositories(
      filters,
      new Set(repositories.map((repository) => repository.value))
    );
    if (next !== filters) setFilters(next);
  }, [filters, repositories, reposQuery.isSuccess, setFilters]);

  return (
    <>
      <SettingsCard
        title="Pull request defaults"
        description="Set the filters applied whenever the Pull Requests page opens."
      >
        <GitHubApiErrorAlert
          error={reposQuery.error}
          fallback="Could not load GitHub repositories"
        />
        <Button
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={!isSignedIn}
        >
          <FunnelIcon />
          Edit default filters
        </Button>
        {!isSignedIn && (
          <p className="text-sm text-low">
            Sign in to configure GitHub pull request defaults.
          </p>
        )}
      </SettingsCard>
      <PullRequestFiltersDialog
        open={isSignedIn && open}
        onOpenChange={setOpen}
        filters={filters}
        repositories={repositories}
        repositoryError={reposQuery.error}
        authors={[]}
        onChange={setFilters}
        onReset={() => setFilters(DEFAULT_PULL_REQUEST_FILTER_STATE)}
        title="Default pull request filters"
        description="These values are applied when the Pull Requests page opens."
      />
    </>
  );
}
