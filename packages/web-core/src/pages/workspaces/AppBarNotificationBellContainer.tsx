import type { MouseEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { BellIcon } from '@phosphor-icons/react';
import { cn } from '@vibe/ui/lib/cn';
import { Tooltip } from '@vibe/ui/components/Tooltip';
import { useNotifications } from '@/shared/hooks/useNotifications';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import {
  openDestinationForActivePane,
  openUrlInSplitPane,
} from '@/shared/lib/openInSplitPane';

export function AppBarNotificationBellContainer() {
  const navigate = useNavigate();
  const appNavigation = useAppNavigation();
  const appRuntime = useAppRuntime();
  const { unseenCount, enabled } = useNotifications();

  if (!enabled) return null;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey) {
      openUrlInSplitPane('/notifications', appNavigation, appRuntime);
      return;
    }
    // Open in the focused split pane when one is selected, else navigate.
    openDestinationForActivePane(
      { kind: 'notifications' },
      appNavigation,
      appRuntime,
      () => void navigate({ to: '/notifications' })
    );
  };

  return (
    <Tooltip content="Notifications" side="right">
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          'relative flex items-center justify-center w-10 h-10 rounded-lg',
          'text-sm font-medium transition-colors cursor-pointer',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          'bg-panel text-normal hover:opacity-80'
        )}
        aria-label="Notifications"
      >
        <BellIcon className="w-5 h-5" weight="bold" />
        {unseenCount > 0 && (
          <span className="absolute -top-2 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-brand-secondary text-[10px] font-medium text-white">
            {unseenCount > 99 ? '99+' : unseenCount}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
