import type { PullRequestFilterState } from './pullRequestFilters';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/Dialog';
import { Switch } from '@vibe/ui/components/Switch';
import { Button } from '@vibe/ui/components/Button';

const selectClassName =
  'h-9 w-full rounded border border-border bg-secondary px-base text-sm text-normal focus:outline-none focus:ring-1 focus:ring-brand';

interface PullRequestFiltersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: PullRequestFilterState;
  repositories: Array<{ value: string; label: string }>;
  authors: string[];
  onChange: (filters: PullRequestFilterState) => void;
  onReset: () => void;
  showRepository?: boolean;
  title?: string;
  description?: string;
}

export function PullRequestFiltersDialog({
  open,
  onOpenChange,
  filters,
  repositories,
  authors,
  onChange,
  onReset,
  showRepository = true,
  title = 'Pull request filters',
  description = 'Choose which pull requests appear in the list.',
}: PullRequestFiltersDialogProps) {
  const update = <K extends keyof PullRequestFilterState>(
    key: K,
    value: PullRequestFilterState[K]
  ) => onChange({ ...filters, [key]: value });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px] p-0">
        <div className="border-b border-border px-double pb-base pt-double">
          <DialogHeader className="space-y-half">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
        </div>

        <div className="grid grid-cols-2 gap-base p-double">
          {showRepository && (
            <label className="space-y-half text-sm text-low">
              <span>Repository</span>
              {repositories.length > 0 ? (
                <select
                  value={filters.repository}
                  onChange={(event) => update('repository', event.target.value)}
                  className={selectClassName}
                >
                  <option value="all">Select a repository</option>
                  {filters.repository !== 'all' &&
                    !repositories.some(
                      (repository) => repository.value === filters.repository
                    ) && (
                      <option value={filters.repository}>
                        {filters.repository}
                      </option>
                    )}
                  {repositories.map((repository) => (
                    <option key={repository.value} value={repository.value}>
                      {repository.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={filters.repository === 'all' ? '' : filters.repository}
                  onChange={(event) =>
                    update('repository', event.target.value || 'all')
                  }
                  placeholder="Repository ID"
                  className={selectClassName}
                />
              )}
            </label>
          )}
          <label className="space-y-half text-sm text-low">
            <span>Status</span>
            <select
              value={filters.status}
              onChange={(event) =>
                update(
                  'status',
                  event.target.value as PullRequestFilterState['status']
                )
              }
              className={selectClassName}
            >
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="merged">Merged</option>
              <option value="closed">Closed</option>
            </select>
          </label>
          <label className="space-y-half text-sm text-low">
            <span>Author</span>
            {authors.length > 0 ? (
              <select
                value={filters.author}
                onChange={(event) => update('author', event.target.value)}
                className={selectClassName}
              >
                <option value="all">All authors</option>
                {filters.author !== 'all' &&
                  !authors.includes(filters.author) && (
                    <option value={filters.author}>{filters.author}</option>
                  )}
                {authors.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={filters.author === 'all' ? '' : filters.author}
                onChange={(event) =>
                  update('author', event.target.value || 'all')
                }
                placeholder="All authors or GitHub login"
                className={selectClassName}
              />
            )}
          </label>
          <label className="space-y-half text-sm text-low">
            <span>Review state</span>
            <select
              value={filters.draft}
              onChange={(event) =>
                update(
                  'draft',
                  event.target.value as PullRequestFilterState['draft']
                )
              }
              className={selectClassName}
            >
              <option value="all">Draft or ready</option>
              <option value="draft">Draft</option>
              <option value="ready">Ready for review</option>
            </select>
          </label>
          <label className="space-y-half text-sm text-low">
            <span>Updated</span>
            <select
              value={filters.updated}
              onChange={(event) =>
                update(
                  'updated',
                  event.target.value as PullRequestFilterState['updated']
                )
              }
              className={selectClassName}
            >
              <option value="all">Anytime</option>
              <option value="day">Last 24 hours</option>
              <option value="week">Last 7 days</option>
              <option value="month">Last 30 days</option>
            </select>
          </label>
          <label className="col-span-2 flex items-center justify-between rounded border border-border bg-secondary p-base">
            <span>
              <span className="block text-sm text-normal">
                Include pull requests involving you
              </span>
              <span className="block text-xs text-low">
                When off, pull requests are not limited to your involvement.
              </span>
            </span>
            <Switch
              checked={filters.involvesMe}
              onCheckedChange={(checked) => update('involvesMe', checked)}
            />
          </label>
        </div>

        <div className="flex justify-between border-t border-border p-base">
          <Button variant="ghost" onClick={onReset}>
            Reset
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
