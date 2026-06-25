import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDownIcon, GitBranchIcon } from '@phosphor-icons/react';
import { Input } from '@vibe/ui/components/Input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { useCreateMode } from '@/features/create-mode/model/useCreateMode';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { pickBranchForRepo } from '@/shared/lib/branchPicker';
import {
  resolveAutoWorkingBranchName,
  validateBranchName,
  type BranchNameError,
} from '@/features/create-mode/model/workingBranch';

/**
 * Workspace-wide working branch selector. The working branch is one per
 * workspace (`workspaces.branch`), so this sits outside the per-repo box. Three
 * modes: auto (issue-template or `vk/…`), an explicit new name, or an existing
 * branch to continue on (single-repo only).
 */
export function WorkingBranchRow() {
  const { t } = useTranslation('common');
  const { repos, workingBranch, setWorkingBranch, linkedIssue } =
    useCreateMode();
  const { config } = useUserSystem();
  const [pickingExisting, setPickingExisting] = useState(false);
  const [nameError, setNameError] = useState<BranchNameError | null>(null);

  const template = config?.git_branch_name_template ?? '';
  const prefix = config?.git_branch_prefix ?? '';
  const singleRepo = repos.length === 1;

  // `auto` defers to the backend, which appends a uuid we can't know here, so
  // the preview is intentionally an approximation rather than the exact name.
  const autoPreview = prefix
    ? t('createMode.workingBranch.autoPreviewPrefixed', { prefix })
    : t('createMode.workingBranch.autoPreviewPlain');

  // Existing-branch reuse is single-repo only. If the repo set grows past one
  // while an existing branch is selected, fall back to auto so we never submit
  // a request the backend would reject.
  useEffect(() => {
    if (workingBranch.mode === 'existing' && !singleRepo) {
      setWorkingBranch({ mode: 'auto' });
      setNameError(null);
    }
  }, [singleRepo, workingBranch.mode, setWorkingBranch]);

  const selectAuto = useCallback(() => {
    setNameError(null);
    setWorkingBranch({ mode: 'auto' });
  }, [setWorkingBranch]);

  // Pre-fill the issue-template name as a suggestion so issue-based naming is
  // one click away, even though `auto` itself no longer applies the template.
  const selectNew = useCallback(() => {
    const suggested = resolveAutoWorkingBranchName(template, linkedIssue) ?? '';
    setWorkingBranch({ mode: 'new', name: suggested });
    setNameError(suggested ? validateBranchName(suggested) : null);
  }, [setWorkingBranch, template, linkedIssue]);

  const pickExisting = useCallback(async () => {
    const repo = repos[0];
    if (!repo) return;
    setPickingExisting(true);
    try {
      const branch = await pickBranchForRepo(repo);
      if (branch) {
        setNameError(null);
        setWorkingBranch({ mode: 'existing', name: branch });
      }
    } finally {
      setPickingExisting(false);
    }
  }, [repos, setWorkingBranch]);

  const handleNameChange = useCallback(
    (value: string) => {
      setWorkingBranch({ mode: 'new', name: value });
      setNameError(value.trim() ? validateBranchName(value) : null);
    },
    [setWorkingBranch]
  );

  const modeLabel = t(`createMode.workingBranch.modes.${workingBranch.mode}`);

  if (repos.length === 0) return null;

  return (
    <div className="mt-base rounded-sm border border-border/60 px-base py-half">
      <div className="flex min-w-0 items-center gap-half">
        <GitBranchIcon
          className="size-icon-xs shrink-0 text-low"
          weight="bold"
        />
        <span className="shrink-0 text-sm text-low">
          {t('createMode.workingBranch.label')}
        </span>
        <span className="h-3 w-px shrink-0 bg-border/70" />

        <div className="min-w-0 flex-1">
          {workingBranch.mode === 'auto' && (
            <span className="block truncate text-sm text-low">
              {autoPreview}
            </span>
          )}
          {workingBranch.mode === 'new' && (
            <Input
              value={workingBranch.name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder={t('createMode.workingBranch.newPlaceholder')}
              className="h-7 text-sm"
              autoFocus
            />
          )}
          {workingBranch.mode === 'existing' && (
            <span className="block truncate text-sm text-normal">
              {workingBranch.name}
            </span>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ml-auto inline-flex shrink-0 items-center gap-half rounded-sm px-half py-half text-sm text-low hover:text-high"
            >
              <span>{modeLabel}</span>
              <CaretDownIcon className="size-icon-2xs" weight="bold" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={selectAuto}>
              {t('createMode.workingBranch.modes.auto')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={selectNew}>
              {t('createMode.workingBranch.modes.new')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={pickExisting}
              disabled={!singleRepo || pickingExisting}
            >
              {t('createMode.workingBranch.modes.existing')}
              {!singleRepo && (
                <span className="ml-half text-xs text-low">
                  {t('createMode.workingBranch.singleRepoOnly')}
                </span>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {nameError && (
        <p className="mt-half text-xs text-error">
          {t(`createMode.workingBranch.errors.${nameError}`)}
        </p>
      )}
    </div>
  );
}
