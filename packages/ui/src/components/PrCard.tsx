import {
  GitPullRequestIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  SpinnerGapIcon,
  DotsThreeIcon,
  CopyIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { openExternalUrl } from '../lib/open-url';
import { Tooltip } from './Tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './DropdownMenu';

export interface PrCardProps {
  repoId: string;
  repoName: string;
  prNumber: number;
  prUrl?: string;
  prStatus: 'open' | 'merged' | 'closed' | 'unknown';
  /** PR head (source) branch, e.g. the feature branch. */
  headBranch: string;
  /** PR base (target) branch, e.g. develop. */
  baseBranch: string;
  /** Commits the head branch is ahead of its counterpart on origin (pushable). */
  headRemoteAhead?: number;
  /** Commits the head branch is behind origin (fetchable). */
  headRemoteBehind?: number;
  /** Commits the head branch is ahead of the base branch — this PR's own size. */
  prAhead?: number;
  /** Commits the head branch is behind the base branch. */
  prBehind?: number;
  /** Whether the head branch can be pushed (a local branch, not remote-only). */
  canPush?: boolean;
  isFetching?: boolean;
  isPushing?: boolean;
  onFetch?: () => void;
  onPush?: () => void;
}

const iconButtonClass =
  'flex items-center justify-center p-1.5 rounded hover:bg-tertiary text-low hover:text-base transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed';

/** Best-effort clipboard copy; silently ignored when unavailable. */
function copyText(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

/** Inline ahead (↑, green) / behind (↓, red) counts; a dash when both are 0. */
function AheadBehind({ ahead, behind }: { ahead?: number; behind?: number }) {
  const a = ahead ?? 0;
  const b = behind ?? 0;
  if (a <= 0 && b <= 0) {
    return <span className="text-xs text-low">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-half shrink-0">
      {a > 0 && (
        <span className="inline-flex items-center gap-0.5 text-xs text-success">
          <ArrowUpIcon className="size-icon-xs" weight="bold" />
          <span className="font-medium">{a}</span>
        </span>
      )}
      {b > 0 && (
        <span className="inline-flex items-center gap-0.5 text-xs text-error">
          <ArrowDownIcon className="size-icon-xs" weight="bold" />
          <span className="font-medium">{b}</span>
        </span>
      )}
    </span>
  );
}

/** Branch chip: truncates inline, shows the full name on hover, copies on click. */
function BranchChip({ branch }: { branch: string }) {
  return (
    <Tooltip content={branch} side="top">
      <button
        type="button"
        onClick={() => copyText(branch)}
        className="min-w-0 flex-1 truncate rounded px-1 text-left font-medium hover:bg-tertiary transition-colors"
      >
        {branch}
      </button>
    </Tooltip>
  );
}

export function PrCard({
  repoName,
  prNumber,
  prUrl,
  prStatus,
  headBranch,
  baseBranch,
  headRemoteAhead,
  headRemoteBehind,
  prAhead,
  prBehind,
  canPush = false,
  isFetching = false,
  isPushing = false,
  onFetch,
  onPush,
}: PrCardProps) {
  const { t } = useTranslation('tasks');
  // Fetch/push only make sense for an open PR; merged/closed cards are read-only.
  const isOpen = prStatus === 'open';

  return (
    <div className="bg-primary rounded-sm my-base p-base space-y-base">
      {/* Header: repo name + fetch (once, refreshes head & base) + PR menu */}
      <div className="flex items-center gap-half">
        <div className="min-w-0 flex-1 font-medium truncate">{repoName}</div>
        {isOpen && (
          <Tooltip content={t('prPanel.fetch')} side="top">
            <button
              type="button"
              onClick={onFetch}
              disabled={isFetching}
              className={iconButtonClass}
            >
              {isFetching ? (
                <SpinnerGapIcon className="size-icon-base animate-spin" />
              ) : (
                <ArrowsClockwiseIcon className="size-icon-base" weight="bold" />
              )}
            </button>
          </Tooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={iconButtonClass}>
              <DotsThreeIcon className="size-icon-base" weight="bold" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => prUrl && openExternalUrl(prUrl)}
              disabled={!prUrl}
            >
              <ArrowSquareOutIcon className="size-icon-xs" weight="bold" />
              {t('prPanel.openInBrowser')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => prUrl && copyText(prUrl)}
              disabled={!prUrl}
            >
              <CopyIcon className="size-icon-xs" weight="bold" />
              {t('prPanel.copyUrl')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* PR identity + open link + status badge */}
      <div className="flex items-center gap-half">
        {prUrl ? (
          <button
            type="button"
            onClick={() => openExternalUrl(prUrl)}
            className="inline-flex items-center gap-half px-base py-half rounded-sm bg-panel text-normal hover:bg-tertiary text-sm font-medium transition-colors"
          >
            <GitPullRequestIcon className="size-icon-xs" weight="fill" />
            {t('prPanel.prLabel', { number: prNumber })}
            <ArrowSquareOutIcon className="size-icon-xs" weight="bold" />
          </button>
        ) : (
          <span className="inline-flex items-center gap-half px-base py-half rounded-sm bg-panel text-normal text-sm font-medium">
            <GitPullRequestIcon className="size-icon-xs" weight="fill" />
            {t('prPanel.prLabel', { number: prNumber })}
          </span>
        )}
        {prStatus === 'merged' && (
          <span className="text-xs font-medium text-success">
            {t('git.states.merged')}
          </span>
        )}
        {prStatus === 'closed' && (
          <span className="text-xs font-medium text-low">
            {t('git.states.closed')}
          </span>
        )}
      </div>

      {/* Direction: head → base (both truncate; hover for full name, click to copy) */}
      <div className="flex items-center gap-half text-sm min-w-0">
        <BranchChip branch={headBranch} />
        <ArrowRightIcon
          className="size-icon-xs text-low shrink-0"
          weight="bold"
        />
        <BranchChip branch={baseBranch} />
      </div>

      {/* Head branch: origin sync + push */}
      <div className="flex items-center gap-base">
        <div className="min-w-0 flex-1 text-xs text-low">
          <span className="uppercase tracking-wide">
            {t('prPanel.headLabel')}
          </span>{' '}
          <span title={t('prPanel.originSyncTooltip')}>
            {t('prPanel.originSync')}
          </span>
        </div>
        <AheadBehind ahead={headRemoteAhead} behind={headRemoteBehind} />
        {canPush && (
          <Tooltip content={t('prPanel.push')} side="top">
            <button
              type="button"
              onClick={onPush}
              disabled={isPushing}
              className={iconButtonClass}
            >
              {isPushing ? (
                <SpinnerGapIcon className="size-icon-base animate-spin" />
              ) : (
                <ArrowUpIcon className="size-icon-base" weight="bold" />
              )}
            </button>
          </Tooltip>
        )}
      </div>

      {/* Base branch: this PR's ahead/behind vs base */}
      <div className="flex items-center gap-base">
        <div className="min-w-0 flex-1 text-xs text-low">
          <span className="uppercase tracking-wide">
            {t('prPanel.baseLabel')}
          </span>{' '}
          <span title={t('prPanel.prSyncTooltip')}>{t('prPanel.prSync')}</span>
        </div>
        <AheadBehind ahead={prAhead} behind={prBehind} />
      </div>
    </div>
  );
}
