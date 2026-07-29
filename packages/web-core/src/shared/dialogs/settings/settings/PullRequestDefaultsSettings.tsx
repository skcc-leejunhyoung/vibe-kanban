import { useState } from 'react';
import { FunnelIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { SettingsCard } from './SettingsComponents';
import { PullRequestFiltersDialog } from '@/pages/pull-requests/PullRequestFiltersDialog';
import { DEFAULT_PULL_REQUEST_FILTER_STATE } from '@/pages/pull-requests/pullRequestFilters';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';

export function PullRequestDefaultsSettings() {
  const [open, setOpen] = useState(false);
  const filters = useUiPreferencesStore(
    (state) => state.pullRequestDefaultFilters
  );
  const setFilters = useUiPreferencesStore(
    (state) => state.setPullRequestDefaultFilters
  );

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
        repositories={[]}
        authors={[]}
        onChange={setFilters}
        onReset={() => setFilters(DEFAULT_PULL_REQUEST_FILTER_STATE)}
        title="Default pull request filters"
        description="These values are applied when the Pull Requests page opens."
      />
    </>
  );
}
