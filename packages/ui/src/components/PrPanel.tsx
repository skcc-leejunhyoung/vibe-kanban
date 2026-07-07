import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { PrCard, type PrCardProps } from './PrCard';

/** PR card data without the interaction callbacks (bound by repoId in the panel). */
export type PrInfo = Omit<PrCardProps, 'onFetch' | 'onPush' | 'onPull'>;

interface PrPanelProps {
  prs: PrInfo[];
  onFetch?: (repoId: string) => void;
  onPush?: (repoId: string) => void;
  onPull?: (repoId: string) => void;
  className?: string;
}

export function PrPanel({
  prs,
  onFetch,
  onPush,
  onPull,
  className,
}: PrPanelProps) {
  const { t } = useTranslation('tasks');

  return (
    <div
      className={cn(
        'flex flex-col flex-1 w-full bg-secondary text-low overflow-y-auto',
        className
      )}
    >
      <div className="gap-base px-base">
        {prs.length === 0 ? (
          <p className="text-sm text-low py-base">{t('prPanel.empty')}</p>
        ) : (
          prs.map((pr) => (
            <PrCard
              key={`${pr.repoId}-${pr.prNumber}`}
              {...pr}
              onFetch={() => onFetch?.(pr.repoId)}
              onPush={() => onPush?.(pr.repoId)}
              onPull={() => onPull?.(pr.repoId)}
            />
          ))
        )}
      </div>
    </div>
  );
}
