import type { ReactNode } from 'react';
import { CaretRightIcon, ListChecksIcon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';

interface ChatCollapsedStepsProps {
  /** Header text, e.g. "12 steps". */
  label: string;
  expanded: boolean;
  isHovered: boolean;
  onToggle: () => void;
  onHoverChange: (hovered: boolean) => void;
  className?: string;
  /** The steps themselves, rendered only while expanded. */
  children: ReactNode;
}

/**
 * The steps a finished turn took before its final answer, folded behind one
 * clickable row. Mirrors ChatCollapsedThinking's header.
 */
export function ChatCollapsedSteps({
  label,
  expanded,
  isHovered,
  onToggle,
  onHoverChange,
  className,
  children,
}: ChatCollapsedStepsProps) {
  return (
    <div className={cn('flex flex-col', className)}>
      <div
        className="flex items-center gap-base text-sm text-low cursor-pointer group"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-scroll-anchor-target=""
      >
        <span className="shrink-0 pt-0.5">
          {isHovered ? (
            <CaretRightIcon
              className={cn(
                'size-icon-base transition-transform duration-150',
                expanded && 'rotate-90'
              )}
            />
          ) : (
            <ListChecksIcon className="size-icon-base" />
          )}
        </span>
        <span className="truncate">{label}</span>
      </div>

      {expanded && (
        <div className="ml-base mt-half flex flex-col border-l border-border">
          {children}
        </div>
      )}
    </div>
  );
}
