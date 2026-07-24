'use client';

import { cn } from '../lib/cn';
import { ButtonGroup, ButtonGroupItem } from './IconButtonGroup';

export interface ViewNavItem {
  id: string;
  name: string;
}

export interface ViewNavTabsProps {
  /** Ordered user-defined views to render as tabs. */
  views: ViewNavItem[];
  activeViewId: string;
  onSelect: (viewId: string) => void;
  className?: string;
}

/**
 * Renders the project's views as a horizontal tab group. Each tab switches the
 * active view (layout + groups + default filters). Views are managed in the
 * project settings; this is purely the switcher.
 */
export function ViewNavTabs({
  views,
  activeViewId,
  onSelect,
  className,
}: ViewNavTabsProps) {
  if (views.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-base">
      <ButtonGroup className={cn('flex-wrap', className)}>
        {views.map((view) => (
          <ButtonGroupItem
            key={view.id}
            active={view.id === activeViewId}
            onClick={() => onSelect(view.id)}
          >
            {view.name}
          </ButtonGroupItem>
        ))}
      </ButtonGroup>
    </div>
  );
}
