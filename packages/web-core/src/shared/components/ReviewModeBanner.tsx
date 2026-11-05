import { useTranslation } from 'react-i18next';
import { Switch } from '@vibe/ui/components/Switch';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { LoginRequiredPrompt } from '@/shared/dialogs/shared/LoginRequiredPrompt';
import type { ReviewModeState } from '@/shared/hooks/useReviewMode';

interface ReviewModeBannerProps {
  /** An open PR for the selected repo was resolved. */
  resolved: boolean;
  /** Still fetching the repo's open PRs. */
  isResolving: boolean;
  /** Head (feature) branch of the resolved PR. */
  headBranch: string | null;
  /** Number of the resolved PR. */
  prNumber: number | null;
  /** Whether review mode is enabled (toggle state). */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  status: ReviewModeState['status'];
  canToggle: boolean;
  requiresLogin: boolean;
  error: unknown;
  onRetry: () => void;
}

/**
 * Shown when creating a workspace from a `review`-tagged issue. Surfaces that
 * work will happen on the issue's open PR head branch (instead of a new `vk/`
 * branch) and lets the user fall back to normal creation.
 */
export function ReviewModeBanner({
  resolved,
  isResolving,
  headBranch,
  prNumber,
  enabled,
  onEnabledChange,
  status,
  canToggle,
  requiresLogin,
  error,
  onRetry,
}: ReviewModeBannerProps) {
  const { t } = useTranslation('common');

  let label: React.ReactNode;
  if (status === 'error') {
    label = requiresLogin ? (
      <LoginRequiredPrompt />
    ) : (
      <div role="alert" className="flex flex-wrap items-center gap-base">
        <span>
          {t('createMode.reviewMode.failed')}
          {error instanceof Error ? `: ${error.message}` : ''}
        </span>
        <PrimaryButton onClick={onRetry}>{t('buttons.retry')}</PrimaryButton>
      </div>
    );
  } else if (status === 'repository-required') {
    label = <span>{t('createMode.reviewMode.singleRepo')}</span>;
  } else if (isResolving) {
    label = (
      <span className="text-muted">
        {t('createMode.reviewMode.resolving', 'Checking for an open PR…')}
      </span>
    );
  } else if (resolved && enabled) {
    label = (
      <span className="text-high">
        {t('createMode.reviewMode.active', 'Review mode')}
        <span className="text-muted">
          {' · '}
          {t('createMode.reviewMode.activeDetail', {
            defaultValue: 'PR #{{number}} · working on {{branch}}',
            number: prNumber ?? 0,
            branch: headBranch ?? '',
          })}
        </span>
      </span>
    );
  } else if (!enabled) {
    label = (
      <span className="text-muted">
        {t(
          'createMode.reviewMode.disabled',
          'Review mode off — a new branch will be created'
        )}
      </span>
    );
  } else {
    label = (
      <span className="text-muted">
        {t(
          'createMode.reviewMode.noPr',
          'No open PR found for this issue — a new branch will be created'
        )}
      </span>
    );
  }

  return (
    <div className="mx-auto flex w-chat max-w-full items-center justify-between gap-base rounded-md border border-border bg-secondary px-base py-half text-sm">
      <div className="min-w-0" role="status">
        {label}
      </div>
      <label className="flex shrink-0 cursor-pointer items-center gap-half">
        <span className="text-muted">
          {t('createMode.reviewMode.toggleLabel', 'Review mode')}
        </span>
        <Switch
          checked={enabled}
          disabled={!canToggle}
          onCheckedChange={onEnabledChange}
        />
      </label>
    </div>
  );
}
