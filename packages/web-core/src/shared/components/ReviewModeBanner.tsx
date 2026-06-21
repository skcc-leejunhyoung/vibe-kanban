import { useTranslation } from 'react-i18next';
import { Switch } from '@vibe/ui/components/Switch';

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
}: ReviewModeBannerProps) {
  const { t } = useTranslation('common');

  let label: React.ReactNode;
  if (isResolving) {
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
  } else if (resolved && !enabled) {
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
      <div className="min-w-0 truncate">{label}</div>
      <label className="flex shrink-0 cursor-pointer items-center gap-half">
        <span className="text-muted">
          {t('createMode.reviewMode.toggleLabel', 'Review mode')}
        </span>
        <Switch
          checked={resolved && enabled}
          disabled={!resolved}
          onCheckedChange={onEnabledChange}
        />
      </label>
    </div>
  );
}
