import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/Dialog';
import { PropertyDropdown } from '@vibe/ui/components/PropertyDropdown';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import {
  ButtonGroup,
  ButtonGroupItem,
} from '@vibe/ui/components/IconButtonGroup';
import {
  MultiSelectDropdown,
  type MultiSelectDropdownOption,
} from '@vibe/ui/components/MultiSelectDropdown';
import {
  FolderIcon,
  GitPullRequestIcon,
  PulseIcon,
  ComputerTowerIcon,
  XIcon,
} from '@phosphor-icons/react';
import type {
  WorkspaceActivityStatus,
  WorkspacePrFilter,
  WorkspaceSortBy,
  WorkspaceSortOrder,
} from '@/shared/stores/useUiPreferencesStore';

// Shared option orders, reused by both the dialogs and the sort/filter hook.
export const PR_FILTER_OPTIONS: WorkspacePrFilter[] = [
  'all',
  'has_pr',
  'no_pr',
];
export const STATUS_FILTER_OPTIONS: WorkspaceActivityStatus[] = [
  'running',
  'attention',
  'idle',
];
export const SORT_BY_OPTIONS: WorkspaceSortBy[] = ['updated_at', 'created_at'];

export interface WorkspacesSortDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sortBy: WorkspaceSortBy;
  sortOrder: WorkspaceSortOrder;
  onSortByChange: (sortBy: WorkspaceSortBy) => void;
  onSortOrderChange: (sortOrder: WorkspaceSortOrder) => void;
}

export function WorkspacesSortDialog({
  open,
  onOpenChange,
  sortBy,
  sortOrder,
  onSortByChange,
  onSortOrderChange,
}: WorkspacesSortDialogProps) {
  const { t } = useTranslation('common');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0">
        <div className="border-b border-border px-double pb-base pt-double">
          <DialogHeader className="space-y-half">
            <DialogTitle>
              {t('kanban.workspaceSidebar.sortDialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('kanban.workspaceSidebar.sortDialogDescription')}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="px-double py-double">
          <div className="flex flex-col gap-base">
            <div className="flex items-center justify-between gap-base">
              <span className="text-sm text-low">
                {t('kanban.workspaceSidebar.sortByLabel')}
              </span>
              <PropertyDropdown
                value={sortBy}
                options={SORT_BY_OPTIONS.map((option) => ({
                  value: option,
                  label:
                    option === 'updated_at'
                      ? t('kanban.workspaceSidebar.sortUpdatedAt')
                      : t('kanban.workspaceSidebar.sortCreatedAt'),
                }))}
                onChange={onSortByChange}
              />
            </div>
            <div className="flex items-center justify-between gap-base">
              <span className="text-sm text-low">
                {t('kanban.workspaceSidebar.sortOrderLabel')}
              </span>
              <ButtonGroup>
                <ButtonGroupItem
                  active={sortOrder === 'desc'}
                  onClick={() => onSortOrderChange('desc')}
                >
                  {t('kanban.sortDescending')}
                </ButtonGroupItem>
                <ButtonGroupItem
                  active={sortOrder === 'asc'}
                  onClick={() => onSortOrderChange('asc')}
                >
                  {t('kanban.sortAscending')}
                </ButtonGroupItem>
              </ButtonGroup>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface WorkspacesFilterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectOptions: MultiSelectDropdownOption<string>[];
  hostOptions: MultiSelectDropdownOption<string>[];
  excludedHostIds: string[];
  projectIds: string[];
  prFilter: WorkspacePrFilter;
  statusFilters: WorkspaceActivityStatus[];
  hasActiveFilters: boolean;
  onProjectFilterChange: (projectIds: string[]) => void;
  onPrFilterChange: (prFilter: WorkspacePrFilter) => void;
  onStatusFilterChange: (statusFilters: WorkspaceActivityStatus[]) => void;
  onHostFilterChange: (excludedHostIds: string[]) => void;
  onClearFilters: () => void;
}

export function WorkspacesFilterDialog({
  open,
  onOpenChange,
  projectOptions,
  hostOptions,
  excludedHostIds,
  projectIds,
  prFilter,
  statusFilters,
  hasActiveFilters,
  onProjectFilterChange,
  onPrFilterChange,
  onStatusFilterChange,
  onHostFilterChange,
  onClearFilters,
}: WorkspacesFilterDialogProps) {
  const { t } = useTranslation('common');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0">
        <div className="border-b border-border px-double pb-base pt-double">
          <DialogHeader className="space-y-half">
            <DialogTitle>
              {t('kanban.workspaceSidebar.filterDialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('kanban.workspaceSidebar.filterDialogDescription')}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="px-double py-double">
          <div className="flex flex-col items-start gap-base">
            <div className="w-full rounded border border-border p-base">
              <div className="mb-half flex items-center gap-half text-sm text-low">
                <ComputerTowerIcon className="size-icon-sm" />
                Hosts
              </div>
              <div className="flex flex-col gap-half">
                {hostOptions.map((option) => {
                  const isVisible = !excludedHostIds.includes(option.value);
                  return (
                    <label
                      key={option.value}
                      className="flex cursor-pointer items-center gap-half text-sm text-normal"
                    >
                      <input
                        type="checkbox"
                        checked={isVisible}
                        onChange={() =>
                          onHostFilterChange(
                            isVisible
                              ? [...excludedHostIds, option.value]
                              : excludedHostIds.filter(
                                  (hostId) => hostId !== option.value
                                )
                          )
                        }
                      />
                      {option.label}
                    </label>
                  );
                })}
              </div>
            </div>
            <MultiSelectDropdown
              values={projectIds}
              options={projectOptions}
              onChange={onProjectFilterChange}
              icon={FolderIcon}
              label={t('kanban.workspaceSidebar.projectFilterLabel')}
            />
            <PropertyDropdown
              value={prFilter}
              options={PR_FILTER_OPTIONS.map((option) => ({
                value: option,
                label:
                  option === 'all'
                    ? t('kanban.workspaceSidebar.prFilterAll')
                    : option === 'has_pr'
                      ? t('kanban.workspaceSidebar.prFilterHasPr')
                      : t('kanban.workspaceSidebar.prFilterNoPr'),
              }))}
              onChange={onPrFilterChange}
              icon={GitPullRequestIcon}
              label={t('kanban.workspaceSidebar.prFilterLabel')}
            />
            <MultiSelectDropdown
              values={statusFilters}
              options={STATUS_FILTER_OPTIONS.map((option) => ({
                value: option,
                label:
                  option === 'running'
                    ? t('kanban.workspaceSidebar.statusRunning')
                    : option === 'attention'
                      ? t('kanban.workspaceSidebar.statusAttention')
                      : t('kanban.workspaceSidebar.statusIdle'),
              }))}
              onChange={onStatusFilterChange}
              icon={PulseIcon}
              label={t('kanban.workspaceSidebar.statusFilterLabel')}
            />
            {hasActiveFilters && (
              <div className="self-end">
                <PrimaryButton
                  variant="tertiary"
                  value={t('kanban.clearFilters')}
                  actionIcon={XIcon}
                  onClick={onClearFilters}
                />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
