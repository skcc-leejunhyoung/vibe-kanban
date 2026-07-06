import { useMemo, type ReactNode } from 'react';
import {
  GitBranchIcon,
  GitPullRequestIcon,
  ArrowsClockwiseIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  CrosshairIcon,
  ArrowSquareOutIcon,
  GitMergeIcon,
  GitCommitIcon,
  CheckCircleIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
  DotsThreeIcon,
  LinkIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuTriggerButton,
  DropdownMenuContent,
  DropdownMenuItem,
} from './Dropdown';
import { SplitButton, type SplitButtonOption } from './SplitButton';
import { openExternalUrl } from '../lib/open-url';

export type RepoAction =
  | 'commit'
  | 'pull-request'
  | 'link-pr'
  | 'merge'
  | 'change-target'
  | 'rebase'
  | 'update-from-base'
  | 'pull'
  | 'push';

const repoActionOptions: SplitButtonOption<RepoAction>[] = [
  { value: 'commit', label: 'Commit', icon: GitCommitIcon },
  {
    value: 'pull-request',
    label: 'Open pull request',
    icon: GitPullRequestIcon,
  },
  { value: 'link-pr', label: 'Link pull request', icon: LinkIcon },
  { value: 'merge', label: 'Merge', icon: GitMergeIcon },
  { value: 'pull', label: 'Pull', icon: ArrowDownIcon },
];

interface RepoCardProps {
  repoId: string;
  name: string;
  targetBranch: string;
  commitsAhead?: number;
  commitsBehind?: number;
  prNumber?: number;
  prUrl?: string;
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
  showPushButton?: boolean;
  isPushPending?: boolean;
  isPushSuccess?: boolean;
  isPushError?: boolean;
  /** Show a "push target branch to origin" button on the branch row. */
  showTargetPushButton?: boolean;
  /** Commits the local target branch is ahead of origin (button label count). */
  targetPushAhead?: number;
  isTargetPushPending?: boolean;
  isTargetPushSuccess?: boolean;
  isTargetPushError?: boolean;
  onTargetPushClick?: () => void;
  isTargetRemote?: boolean;
  hasUncommittedChanges?: boolean;
  branchDropdownContent?: ReactNode;
  selectedAction?: RepoAction;
  onSelectedActionChange?: (action: RepoAction) => void;
  onChangeTarget?: () => void;
  onRebase?: () => void;
  onUpdateFromBase?: () => void;
  onActionsClick?: (action: RepoAction) => void;
  onPushClick?: () => void;
  onMoreClick?: () => void;
}

export function RepoCard({
  name,
  targetBranch,
  commitsAhead = 0,
  commitsBehind = 0,
  prNumber,
  prUrl,
  prStatus,
  showPushButton = false,
  isPushPending = false,
  isPushSuccess = false,
  isPushError = false,
  showTargetPushButton = false,
  targetPushAhead = 0,
  isTargetPushPending = false,
  isTargetPushSuccess = false,
  isTargetPushError = false,
  onTargetPushClick,
  isTargetRemote = false,
  hasUncommittedChanges = false,
  branchDropdownContent,
  selectedAction = 'pull-request',
  onSelectedActionChange,
  onChangeTarget,
  onRebase,
  onUpdateFromBase,
  onActionsClick,
  onPushClick,
  onMoreClick,
}: RepoCardProps) {
  const { t } = useTranslation('tasks');
  const { t: tCommon } = useTranslation('common');

  // Hide "Commit" when the worktree has no uncommitted changes
  // Hide "Open pull request" and "Link pull request" when PR is already open
  // Hide "Link pull request" when any PR is already linked (open or merged)
  // Hide "merge" option when PR is already open or target branch is remote
  const hasPrOpen = prStatus === 'open';
  const hasPrLinked = !!prNumber;
  const availableActionOptions = useMemo(
    () =>
      repoActionOptions.filter((opt) => {
        if (opt.value === 'commit' && !hasUncommittedChanges) return false;
        if (opt.value === 'pull-request' && hasPrOpen) return false;
        if (opt.value === 'link-pr' && hasPrLinked) return false;
        if (opt.value === 'merge' && (hasPrOpen || isTargetRemote))
          return false;
        return true;
      }),
    [hasUncommittedChanges, hasPrOpen, hasPrLinked, isTargetRemote]
  );

  // If current selection is unavailable, fall back to the first available option.
  const effectiveSelectedAction = useMemo(() => {
    const selectedOption = availableActionOptions.find(
      (option) => option.value === selectedAction
    );
    return (
      selectedOption?.value ??
      availableActionOptions[0]?.value ??
      selectedAction
    );
  }, [availableActionOptions, selectedAction]);

  return (
    <div className="bg-primary rounded-sm my-base p-base space-y-base">
      <div className="font-medium">{name}</div>
      {/* Branch row */}
      <div className="flex items-center gap-base">
        <div className="min-w-0 flex-1">
          <DropdownMenu>
            <DropdownMenuTriggerButton
              icon={GitBranchIcon}
              label={targetBranch}
              className="max-w-full"
            />
            <DropdownMenuContent>
              {branchDropdownContent ?? (
                <>
                  <DropdownMenuItem
                    icon={CrosshairIcon}
                    onClick={onChangeTarget}
                  >
                    {t('git.actions.changeTarget')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={GitMergeIcon}
                    onClick={onUpdateFromBase}
                  >
                    {t('git.actions.updateFromBase')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={ArrowsClockwiseIcon}
                    onClick={onRebase}
                  >
                    {t('rebase.common.action')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Commits ahead/behind indicators */}
        {commitsAhead > 0 && (
          <span className="inline-flex items-center gap-0.5 text-xs text-success shrink-0">
            <ArrowUpIcon className="size-icon-xs" weight="bold" />
            <span className="font-medium">{commitsAhead}</span>
          </span>
        )}
        {commitsBehind > 0 && (
          <span className="inline-flex items-center gap-0.5 text-xs text-error shrink-0">
            <ArrowDownIcon className="size-icon-xs" weight="bold" />
            <span className="font-medium">{commitsBehind}</span>
          </span>
        )}

        {/* Push target branch to origin - shown when the local target branch is
            ahead of its remote counterpart. Mirrors the work-branch push button
            state feedback. */}
        {(showTargetPushButton ||
          isTargetPushPending ||
          isTargetPushSuccess ||
          isTargetPushError) && (
          <button
            onClick={onTargetPushClick}
            disabled={
              isTargetPushPending || isTargetPushSuccess || isTargetPushError
            }
            title={t('git.actions.pushTargetToOrigin', {
              branch: targetBranch,
            })}
            className={`inline-flex items-center gap-half px-base py-half rounded-sm text-sm font-medium transition-colors shrink-0 disabled:cursor-not-allowed ${
              isTargetPushSuccess
                ? 'bg-success/20 text-success'
                : isTargetPushError
                  ? 'bg-error/20 text-error'
                  : 'bg-panel text-normal hover:bg-tertiary disabled:opacity-50'
            }`}
          >
            {isTargetPushPending ? (
              <SpinnerGapIcon className="size-icon-xs animate-spin" />
            ) : isTargetPushSuccess ? (
              <CheckCircleIcon className="size-icon-xs" weight="fill" />
            ) : isTargetPushError ? (
              <WarningCircleIcon className="size-icon-xs" weight="fill" />
            ) : (
              <ArrowUpIcon className="size-icon-xs" weight="bold" />
            )}
            {isTargetPushPending
              ? t('git.states.pushing')
              : isTargetPushSuccess
                ? t('git.states.pushed')
                : isTargetPushError
                  ? t('git.states.pushFailed')
                  : t('git.states.pushTarget', { ahead: targetPushAhead })}
          </button>
        )}

        <button
          onClick={onMoreClick}
          className="flex items-center justify-center p-1.5 rounded hover:bg-tertiary text-low hover:text-base transition-colors shrink-0"
          title={tCommon('workspaces.more')}
        >
          <DotsThreeIcon className="size-icon-base" weight="bold" />
        </button>
      </div>

      {/* PR status row */}
      {prNumber && (
        <div className="flex items-center gap-half my-base">
          {prStatus === 'merged' ? (
            prUrl ? (
              <button
                onClick={() => openExternalUrl(prUrl)}
                className="inline-flex items-center gap-half px-base py-half rounded-sm bg-panel text-success hover:bg-tertiary text-sm font-medium transition-colors"
              >
                <CheckCircleIcon className="size-icon-xs" weight="fill" />
                {t('git.pr.merged', { prNumber })}
                <ArrowSquareOutIcon className="size-icon-xs" weight="bold" />
              </button>
            ) : (
              <span className="inline-flex items-center gap-half px-base py-half rounded-sm bg-panel text-success text-sm font-medium">
                <CheckCircleIcon className="size-icon-xs" weight="fill" />
                {t('git.pr.merged', { prNumber })}
              </span>
            )
          ) : prUrl ? (
            <button
              onClick={() => openExternalUrl(prUrl)}
              className="inline-flex items-center gap-half px-base py-half rounded-sm bg-panel text-normal hover:bg-tertiary text-sm font-medium transition-colors"
            >
              <GitPullRequestIcon className="size-icon-xs" weight="fill" />
              {t('git.pr.open', { number: prNumber })}
              <ArrowSquareOutIcon className="size-icon-xs" weight="bold" />
            </button>
          ) : (
            <span className="inline-flex items-center gap-half px-base py-half rounded-sm bg-panel text-normal text-sm font-medium">
              <GitPullRequestIcon className="size-icon-xs" weight="fill" />
              {t('git.pr.open', { number: prNumber })}
            </span>
          )}
          {/* Push button - shows loading/success/error state */}
          {(showPushButton ||
            isPushPending ||
            isPushSuccess ||
            isPushError) && (
            <button
              onClick={onPushClick}
              disabled={isPushPending || isPushSuccess || isPushError}
              className={`inline-flex items-center gap-half px-base py-half rounded-sm text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                isPushSuccess
                  ? 'bg-success/20 text-success'
                  : isPushError
                    ? 'bg-error/20 text-error'
                    : 'bg-panel text-normal hover:bg-tertiary disabled:opacity-50'
              }`}
            >
              {isPushPending ? (
                <SpinnerGapIcon className="size-icon-xs animate-spin" />
              ) : isPushSuccess ? (
                <CheckCircleIcon className="size-icon-xs" weight="fill" />
              ) : isPushError ? (
                <WarningCircleIcon className="size-icon-xs" weight="fill" />
              ) : (
                <ArrowUpIcon className="size-icon-xs" weight="bold" />
              )}
              {isPushPending
                ? t('git.states.pushing')
                : isPushSuccess
                  ? t('git.states.pushed')
                  : isPushError
                    ? t('git.states.pushFailed')
                    : t('git.states.push')}
            </button>
          )}
        </div>
      )}

      {/* Actions row - only show when there are available actions */}
      {availableActionOptions.length > 0 && (
        <div className="my-base">
          <SplitButton
            options={availableActionOptions}
            selectedValue={effectiveSelectedAction}
            onSelectionChange={(action) => onSelectedActionChange?.(action)}
            onAction={(action) => onActionsClick?.(action)}
          />
        </div>
      )}
    </div>
  );
}
