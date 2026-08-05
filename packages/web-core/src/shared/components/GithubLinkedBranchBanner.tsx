import { useTranslation } from 'react-i18next';
import { Switch } from '@vibe/ui/components/Switch';

interface GithubLinkedBranchBannerProps {
  /** The issue's GitHub repository (`owner/repo`). */
  repository: string;
  /** Whether the GitHub linked-branch mode is enabled (toggle state). */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

/**
 * Shown when creating a workspace from an issue mapped to a GitHub issue.
 * Surfaces that work will happen on the issue's GitHub linked branch — reused
 * if the issue already has one, otherwise created like the "Create a branch for
 * this issue" button — and lets the user fall back to a normal new branch.
 * Mirrors {@link ReviewModeBanner} so the two branch-source choices read alike.
 */
export function GithubLinkedBranchBanner({
  repository,
  enabled,
  onEnabledChange,
}: GithubLinkedBranchBannerProps) {
  const { t } = useTranslation('common');

  const label = enabled ? (
    <span className="text-high">
      {t('createMode.githubLinkedBranch.active', 'GitHub linked branch')}
      <span className="text-muted">
        {' · '}
        {t('createMode.githubLinkedBranch.activeDetail', {
          defaultValue: "{{repository}} · uses the issue's linked branch",
          repository,
        })}
      </span>
    </span>
  ) : (
    <span className="text-muted">
      {t(
        'createMode.githubLinkedBranch.disabled',
        'GitHub linked branch off — a new branch will be created'
      )}
    </span>
  );

  return (
    <div className="mx-auto flex w-chat max-w-full items-center justify-between gap-base rounded-md border border-border bg-secondary px-base py-half text-sm">
      <div className="min-w-0 truncate">{label}</div>
      <label className="flex shrink-0 cursor-pointer items-center gap-half">
        <span className="text-muted">
          {t(
            'createMode.githubLinkedBranch.toggleLabel',
            'GitHub linked branch'
          )}
        </span>
        <Switch checked={enabled} onCheckedChange={onEnabledChange} />
      </label>
    </div>
  );
}
