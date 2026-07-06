import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CaretDownIcon,
  ClockCounterClockwiseIcon,
  GitBranchIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SpinnerIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { Repo } from 'shared/types';
import type { RepoItem } from '@/shared/types/selectionItems';
import { repoApi } from '@/shared/lib/api';
import { cn } from '@/shared/lib/utils';
import { splitMessageToTitleDescription } from '@/shared/lib/string';
import { useCreateMode } from '@/features/create-mode/model/useCreateMode';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import {
  resolveAutoTargetBranchName,
  validateBranchName,
  type BranchNameError,
  type TargetBranchMode,
} from '@/features/create-mode/model/targetBranch';
import { FolderPickerDialog } from '@/shared/dialogs/shared/FolderPickerDialog';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { CreateRepoDialog } from '@vibe/ui/components/CreateRepoDialog';
import { Input } from '@vibe/ui/components/Input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import {
  SelectionDialog,
  type SelectionPage,
} from '@/shared/dialogs/command-bar/SelectionDialog';
import {
  buildRepoSelectionPages,
  type RepoSelectionResult,
} from '@/shared/dialogs/command-bar/selections/repoSelection';
import { WorkingBranchRow } from '@/shared/components/WorkingBranchRow';
import { pickBranchForRepo } from '@/shared/lib/branchPicker';

function toRepoItem(repo: Repo): RepoItem {
  return {
    id: repo.id,
    display_name: repo.display_name || repo.name,
  };
}

function getRepoDisplayName(repo: Repo): string {
  return repo.display_name || repo.name;
}

type PendingAction = 'choose' | 'browse' | 'create' | null;

const inlineControlButtonClassName =
  'inline-flex items-center gap-half rounded-sm px-half py-half text-sm text-normal ' +
  'hover:text-high disabled:cursor-not-allowed disabled:opacity-50';

const recentInlineControlButtonClassName =
  'inline-flex items-center gap-half rounded-sm px-half py-half text-sm ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const repoRowButtonClassName =
  'inline-flex items-center gap-half text-sm text-low hover:text-high ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Per-repo target ("feature") branch selector. Mirrors the workspace-wide
 * working branch row, but scoped to a single repo: pick an existing branch to
 * fork from (default), type a new feature branch, or auto-generate one from the
 * configured target-branch prefix + template. The "new"/"auto" modes create a
 * fresh branch off the repo's default branch on the backend.
 */
function RepoTargetBranchControl({ repo }: { repo: Repo }) {
  const { t } = useTranslation('common');
  const { config } = useUserSystem();
  const {
    targetBranches,
    targetBranchModes,
    setTargetBranch,
    linkedIssue,
    message,
  } = useCreateMode();

  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const mode: TargetBranchMode = targetBranchModes[repo.id] ?? 'existing';
  const branch = targetBranches[repo.id];
  const prefix = config?.git_target_branch_prefix ?? '';
  const template = config?.git_target_branch_name_template ?? '';

  const nameError: BranchNameError | null =
    mode === 'new' && branch ? validateBranchName(branch) : null;

  const buildAutoName = useCallback(() => {
    const workspaceTitle = splitMessageToTitleDescription(message).title.trim();
    const fallback = workspaceTitle || repo.display_name || repo.name;
    return (
      resolveAutoTargetBranchName(prefix, template, linkedIssue, fallback) ?? ''
    );
  }, [message, prefix, template, linkedIssue, repo]);

  const selectExisting = useCallback(async () => {
    setPickError(null);
    setPicking(true);
    try {
      const picked = await pickBranchForRepo(repo);
      if (picked) setTargetBranch(repo.id, picked, 'existing');
    } catch (error) {
      setPickError(
        error instanceof Error
          ? error.message
          : t('createMode.targetBranch.errors.loadFailed')
      );
    } finally {
      setPicking(false);
    }
  }, [repo, setTargetBranch, t]);

  const selectNew = useCallback(() => {
    setPickError(null);
    // Pre-fill the auto suggestion so an issue-based name is one edit away.
    setTargetBranch(
      repo.id,
      branch && mode === 'new' ? branch : buildAutoName(),
      'new'
    );
  }, [repo.id, branch, mode, buildAutoName, setTargetBranch]);

  const selectAuto = useCallback(() => {
    setPickError(null);
    setTargetBranch(repo.id, buildAutoName(), 'auto');
  }, [repo.id, buildAutoName, setTargetBranch]);

  const handleNameChange = useCallback(
    (value: string) => {
      setTargetBranch(repo.id, value, 'new');
    },
    [repo.id, setTargetBranch]
  );

  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-half">
        <div className="min-w-0 flex-1">
          {mode === 'existing' && (
            <button
              type="button"
              onClick={selectExisting}
              disabled={picking}
              className={repoRowButtonClassName}
              title={t('createMode.targetBranch.changeBranch')}
            >
              {picking ? (
                <SpinnerIcon className="size-icon-xs animate-spin" />
              ) : (
                <GitBranchIcon className="size-icon-xs" weight="bold" />
              )}
              <span className="max-w-[200px] truncate">
                {branch ?? t('createMode.targetBranch.selectBranch')}
              </span>
            </button>
          )}
          {mode === 'new' && (
            <Input
              value={branch ?? ''}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder={t('createMode.targetBranch.newPlaceholder')}
              className="h-7 text-sm"
              autoFocus
            />
          )}
          {mode === 'auto' && (
            <span className="flex min-w-0 items-center gap-half text-sm text-low">
              <GitBranchIcon className="size-icon-xs shrink-0" weight="bold" />
              <span className="truncate">
                {branch || t('createMode.targetBranch.autoPreview')}
              </span>
            </span>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-half rounded-sm px-half py-half text-sm text-low hover:text-high"
            >
              <span>{t(`createMode.targetBranch.modes.${mode}`)}</span>
              <CaretDownIcon className="size-icon-2xs" weight="bold" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={selectAuto}>
              {t('createMode.targetBranch.modes.auto')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={selectNew}>
              {t('createMode.targetBranch.modes.new')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={selectExisting}>
              {t('createMode.targetBranch.modes.existing')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {nameError && (
        <p className="mt-half text-xs text-error">
          {t(`createMode.targetBranch.errors.${nameError}`)}
        </p>
      )}
      {pickError && <p className="mt-half text-xs text-error">{pickError}</p>}
    </div>
  );
}

interface CreateModeRepoPickerBarProps {
  onContinueToPrompt: () => void;
}

export function CreateModeRepoPickerBar({
  onContinueToPrompt,
}: CreateModeRepoPickerBarProps) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const { repos, addRepo, removeRepo, setTargetBranch } = useCreateMode();
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [setupHintDismissed, setSetupHintDismissed] = useState(false);
  const isBusy = pendingAction !== null;

  const hasUnconfiguredRepo = useMemo(
    () => repos.some((repo) => !repo.setup_script),
    [repos]
  );
  const showSetupHint = hasUnconfiguredRepo && !setupHintDismissed;

  const selectedRepoIds = useMemo(
    () => new Set(repos.map((repo) => repo.id)),
    [repos]
  );

  const runPickerAction = useCallback(
    async (
      action: Exclude<PendingAction, null>,
      run: () => Promise<void>,
      fallbackError: string
    ) => {
      setPickerError(null);
      setPendingAction(action);

      try {
        await run();
      } catch (error) {
        setPickerError(error instanceof Error ? error.message : fallbackError);
      } finally {
        setPendingAction(null);
      }
    },
    []
  );

  const addRepoWithBranchSelection = useCallback(
    async (repo: Repo) => {
      if (selectedRepoIds.has(repo.id)) {
        setPickerError('Repository is already selected');
        return false;
      }

      const selectedBranch = await pickBranchForRepo(repo);
      if (!selectedBranch) return false;

      addRepo(repo);
      setTargetBranch(repo.id, selectedBranch, 'existing');
      return true;
    },
    [addRepo, selectedRepoIds, setTargetBranch]
  );

  const handleChooseRepo = useCallback(async () => {
    await runPickerAction(
      'choose',
      async () => {
        const allRepos = await repoApi.listRecent();
        const availableRepos = allRepos.filter(
          (repo) => !selectedRepoIds.has(repo.id)
        );

        if (availableRepos.length === 0) {
          setPickerError(
            'No recently used repositories found, please browse repositories instead'
          );
          return;
        }

        const repoResult = (await SelectionDialog.show({
          initialPageId: 'selectRepo',
          pages: buildRepoSelectionPages(
            availableRepos.map(toRepoItem)
          ) as Record<string, SelectionPage>,
        })) as RepoSelectionResult | undefined;

        if (!repoResult?.repoId) return;

        const selectedRepo = availableRepos.find(
          (repo) => repo.id === repoResult.repoId
        );
        if (!selectedRepo) return;

        await addRepoWithBranchSelection(selectedRepo);
      },
      'Failed to load repositories or branches'
    );
  }, [addRepoWithBranchSelection, runPickerAction, selectedRepoIds]);

  const handleBrowseRepo = useCallback(async () => {
    await runPickerAction(
      'browse',
      async () => {
        const selectedPath = await FolderPickerDialog.show({
          title: t('dialogs.selectGitRepository'),
          description: t('dialogs.chooseExistingRepo'),
        });
        if (!selectedPath) return;

        const repo = await repoApi.register({ path: selectedPath });
        queryClient.invalidateQueries({ queryKey: ['repos'] });
        await addRepoWithBranchSelection(repo);
      },
      'Failed to register repository'
    );
  }, [addRepoWithBranchSelection, runPickerAction, t]);

  const handleCreateRepo = useCallback(async () => {
    await runPickerAction(
      'create',
      async () => {
        await CreateRepoDialog.show({
          onBrowseForPath: async (currentPath) =>
            FolderPickerDialog.show({
              title: t('git.createRepo.browseDialog.title'),
              description: t('git.createRepo.browseDialog.description'),
              value: currentPath,
            }),
          onCreateRepo: async ({ parentPath, folderName }) => {
            const repo = await repoApi.init({
              parent_path: parentPath,
              folder_name: folderName,
            });
            queryClient.invalidateQueries({ queryKey: ['repos'] });
            await addRepoWithBranchSelection(repo);
          },
        });
      },
      'Failed to create repository'
    );
  }, [addRepoWithBranchSelection, runPickerAction, t]);

  return (
    <div className="w-chat max-w-full">
      <div className="px-plusfifty py-base">
        {repos.length > 0 && (
          <div>
            <div className="rounded-sm border border-border/60">
              {repos.map((repo, index) => {
                const repoDisplayName = getRepoDisplayName(repo);

                return (
                  <div
                    key={repo.id}
                    className={cn(
                      'flex min-w-0 items-center gap-half px-base py-half',
                      index > 0 && 'border-t border-border/60'
                    )}
                  >
                    <span className="min-w-0 max-w-[40%] shrink-0 truncate text-sm text-normal">
                      {repoDisplayName}
                    </span>
                    <span className="h-3 w-px shrink-0 bg-border/70" />
                    <RepoTargetBranchControl repo={repo} />
                    <span className="h-3 w-px shrink-0 bg-border/70" />
                    <button
                      type="button"
                      onClick={() => removeRepo(repo.id)}
                      disabled={isBusy}
                      aria-label={`Remove ${repoDisplayName}`}
                      title={`Remove ${repoDisplayName}`}
                      className={cn(repoRowButtonClassName, 'hover:text-error')}
                    >
                      <XIcon className="size-icon-xs" weight="bold" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <WorkingBranchRow />

        <div className="mt-base flex flex-wrap items-center gap-half">
          <button
            type="button"
            onClick={handleChooseRepo}
            disabled={isBusy}
            className={cn(
              recentInlineControlButtonClassName,
              repos.length > 0
                ? 'text-normal hover:text-high'
                : 'text-brand hover:text-brand-hover'
            )}
          >
            {pendingAction === 'choose' ? (
              <SpinnerIcon className="size-icon-xs animate-spin" />
            ) : (
              <ClockCounterClockwiseIcon
                className="size-icon-xs"
                weight="bold"
              />
            )}
            <span>{t('createMode.repoPicker.actions.recent')}</span>
          </button>
          <button
            type="button"
            onClick={handleBrowseRepo}
            disabled={isBusy}
            className={inlineControlButtonClassName}
          >
            {pendingAction === 'browse' ? (
              <SpinnerIcon className="size-icon-xs animate-spin" />
            ) : (
              <MagnifyingGlassIcon className="size-icon-xs" weight="bold" />
            )}
            <span>{t('createMode.repoPicker.actions.browse')}</span>
          </button>
          <button
            type="button"
            onClick={handleCreateRepo}
            disabled={isBusy}
            className={inlineControlButtonClassName}
          >
            {pendingAction === 'create' ? (
              <SpinnerIcon className="size-icon-xs animate-spin" />
            ) : (
              <PlusIcon className="size-icon-xs" weight="bold" />
            )}
            <span>{t('createMode.repoPicker.actions.create')}</span>
          </button>

          <div className="ml-auto">
            <PrimaryButton
              variant="default"
              value="Continue"
              onClick={onContinueToPrompt}
              disabled={isBusy || repos.length === 0}
            />
          </div>
        </div>
      </div>
      {showSetupHint && (
        <div className="mx-plusfifty mt-half flex items-start gap-half rounded-sm border border-brand/20 bg-brand/5 px-base py-base">
          <div className="flex-1">
            <p className="text-sm font-medium text-normal">
              {t('createMode.repoPicker.setupHintTitle')}
            </p>
            <p className="mt-quarter text-sm text-low">
              {t('createMode.repoPicker.setupHint')}
            </p>
            <button
              type="button"
              className="mt-quarter cursor-pointer text-sm font-medium text-brand underline hover:text-brand/80"
              onClick={() => {
                const unconfiguredRepo = repos.find(
                  (repo) => !repo.setup_script
                );
                SettingsDialog.show({
                  initialSection: 'repos',
                  initialState: { repoId: unconfiguredRepo?.id },
                });
              }}
            >
              {t('createMode.repoPicker.setupHintLink')}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setSetupHintDismissed(true)}
            className="shrink-0 text-low hover:text-normal"
            aria-label={t('createMode.repoPicker.setupHintDismiss')}
          >
            <XIcon className="size-icon-2xs" weight="bold" />
          </button>
        </div>
      )}
      {pickerError && (
        <div className="mt-half rounded-sm border border-error/30 bg-error/10 px-base py-half">
          <p className="text-xs text-error">{pickerError}</p>
        </div>
      )}
    </div>
  );
}
