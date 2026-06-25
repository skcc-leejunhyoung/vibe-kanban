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
import { FolderIcon, GitPullRequestIcon, XIcon } from '@phosphor-icons/react';
import type {
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
  projectIds: string[];
  prFilter: WorkspacePrFilter;
  hasActiveFilters: boolean;
  onProjectFilterChange: (projectIds: string[]) => void;
  onPrFilterChange: (prFilter: WorkspacePrFilter) => void;
  onClearFilters: () => void;
}

export function WorkspacesFilterDialog({
  open,
  onOpenChange,
  projectOptions,
  projectIds,
  prFilter,
  hasActiveFilters,
  onProjectFilterChange,
  onPrFilterChange,
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
