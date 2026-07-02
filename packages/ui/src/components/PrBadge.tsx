import { cn } from '../lib/cn';
import { GitPullRequestIcon, XIcon } from '@phosphor-icons/react';

export type PrBadgeStatus = 'open' | 'merged' | 'closed';

export interface PrBadgeProps {
  number: number;
  url: string;
  status: PrBadgeStatus;
  /** When provided, renders a button that unlinks the PR from the issue. */
  onRemove?: () => void;
  disabled?: boolean;
  className?: string;
}

export function PrBadge({
  number,
  url,
  status,
  onRemove,
  disabled,
  className,
}: PrBadgeProps) {
  const colorClasses =
    status === 'merged'
      ? 'bg-merged/10 text-merged'
      : status === 'closed'
        ? 'bg-error/10 text-error'
        : 'bg-success/10 text-success';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded text-xs font-medium',
        colorClasses,
        className
      )}
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'flex items-center gap-half pl-1.5 py-0.5 transition-colors hover:underline',
          onRemove ? 'pr-1' : 'pr-1.5'
        )}
      >
        <GitPullRequestIcon className="size-icon-2xs" weight="bold" />
        <span>#{number}</span>
      </a>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onRemove();
          }}
          disabled={disabled}
          aria-label={`Unlink pull request #${number}`}
          className="flex items-center justify-center pr-1 py-0.5 opacity-60 transition-opacity hover:opacity-100 disabled:opacity-30"
        >
          <XIcon className="size-icon-2xs" weight="bold" />
        </button>
      )}
    </span>
  );
}
