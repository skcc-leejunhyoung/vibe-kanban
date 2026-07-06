import {
  GitPullRequestIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  SpinnerGapIcon,
  DotsThreeIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { openExternalUrl } from '../lib/open-url';

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
  onMore?: () => void;
}

/** Inline ahead (↑, green) / behind (↓, red) counts; renders nothing when both are 0. */
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
  onMore,
}: PrCardProps) {
  const { t } = useTranslation('tasks');
  const { t: tCommon } = useTranslation('common');

  const buttonClass =
    'inline-flex items-center gap-half px-base py-half rounded-sm text-sm font-medium transition-colors shrink-0 bg-panel text-normal hover:bg-tertiary disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="bg-primary rounded-sm my-base p-base space-y-base">
      {/* Header: repo name + more */}
      <div className="flex items-center gap-base">
        <div className="min-w-0 flex-1 font-medium truncate">{repoName}</div>
        <button
          onClick={onMore}
          className="flex items-center justify-center p-1.5 rounded hover:bg-tertiary text-low hover:text-base transition-colors shrink-0"
          title={tCommon('workspaces.more')}
        >
          <DotsThreeIcon className="size-icon-base" weight="bold" />
        </button>
      </div>

      {/* PR identity + open link */}
      <div className="flex items-center gap-half">
        {prUrl ? (
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
        <span className="text-xs text-low capitalize">{prStatus}</span>
      </div>

      {/* Direction: head → base */}
      <div className="flex items-center gap-half text-sm min-w-0">
        <span className="truncate font-medium" title={headBranch}>
          {headBranch}
        </span>
        <ArrowRightIcon
          className="size-icon-xs text-low shrink-0"
          weight="bold"
        />
        <span className="truncate font-medium" title={baseBranch}>
          {baseBranch}
        </span>
      </div>

      {/* Head branch: origin sync + fetch/push */}
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
        <button onClick={onFetch} disabled={isFetching} className={buttonClass}>
          {isFetching ? (
            <SpinnerGapIcon className="size-icon-xs animate-spin" />
          ) : (
            <ArrowsClockwiseIcon className="size-icon-xs" weight="bold" />
          )}
          {t('prPanel.fetch')}
        </button>
        {canPush && (
          <button onClick={onPush} disabled={isPushing} className={buttonClass}>
            {isPushing ? (
              <SpinnerGapIcon className="size-icon-xs animate-spin" />
            ) : (
              <ArrowUpIcon className="size-icon-xs" weight="bold" />
            )}
            {t('prPanel.push')}
          </button>
        )}
      </div>

      {/* Base branch: this PR's ahead/behind vs base + fetch */}
      <div className="flex items-center gap-base">
        <div className="min-w-0 flex-1 text-xs text-low">
          <span className="uppercase tracking-wide">
            {t('prPanel.baseLabel')}
          </span>{' '}
          <span title={t('prPanel.prSyncTooltip')}>{t('prPanel.prSync')}</span>
        </div>
        <AheadBehind ahead={prAhead} behind={prBehind} />
        <button onClick={onFetch} disabled={isFetching} className={buttonClass}>
          {isFetching ? (
            <SpinnerGapIcon className="size-icon-xs animate-spin" />
          ) : (
            <ArrowsClockwiseIcon className="size-icon-xs" weight="bold" />
          )}
          {t('prPanel.fetch')}
        </button>
      </div>
    </div>
  );
}
