import { ArrowClockwiseIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';

export function ProjectLoadingState({
  hasError,
  onRetry,
}: {
  hasError: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-col items-center justify-center gap-base h-full w-full p-base">
      <p role={hasError ? 'alert' : 'status'} className="text-low">
        {hasError ? t('kanban.syncFailed') : t('states.loading')}
      </p>
      <PrimaryButton
        variant="tertiary"
        actionIcon={ArrowClockwiseIcon}
        value={t('kanban.refreshProject')}
        onClick={onRetry}
      />
    </div>
  );
}
