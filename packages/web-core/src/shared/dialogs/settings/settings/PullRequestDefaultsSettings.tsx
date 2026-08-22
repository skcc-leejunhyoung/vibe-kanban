import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FunnelIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { SettingsCard } from './SettingsComponents';
import { PullRequestFiltersDialog } from '@/pages/pull-requests/PullRequestFiltersDialog';
import { DEFAULT_PULL_REQUEST_FILTER_STATE } from '@/pages/pull-requests/pullRequestFilters';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { repoApi } from '@/shared/lib/api';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';

export function PullRequestDefaultsSettings() {
  const hostId = useHostId();
  const [open, setOpen] = useState(false);
  const filters = useUiPreferencesStore(
    (state) => state.pullRequestDefaultFilters
  );
  const setFilters = useUiPreferencesStore(
    (state) => state.setPullRequestDefaultFilters
  );
  const reposQuery = useQuery({
    queryKey: ['repos', getHostRequestScopeQueryKey(hostId)],
    queryFn: () => repoApi.list(hostId),
    staleTime: 5 * 60_000,
  });
  const repositories = (reposQuery.data ?? []).map((repo) => ({
    value: repo.id,
    label: repo.display_name,
  }));

  return (
    <>
      <SettingsCard
        title="Pull request defaults"
        description="Set the filters applied whenever the Pull Requests page opens."
      >
        <Button variant="outline" onClick={() => setOpen(true)}>
          <FunnelIcon />
          Edit default filters
        </Button>
      </SettingsCard>
      <PullRequestFiltersDialog
        open={open}
        onOpenChange={setOpen}
        filters={filters}
        repositories={repositories}
        authors={[]}
        onChange={setFilters}
        onReset={() => setFilters(DEFAULT_PULL_REQUEST_FILTER_STATE)}
        title="Default pull request filters"
        description="These values are applied when the Pull Requests page opens."
      />
    </>
  );
}
