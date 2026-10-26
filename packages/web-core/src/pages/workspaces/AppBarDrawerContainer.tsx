import type { MouseEvent } from 'react';
import { TrayIcon } from '@phosphor-icons/react';
import { cn } from '@vibe/ui/lib/cn';
import { Tooltip } from '@vibe/ui/components/Tooltip';
import { useDrawerNotes } from '@/shared/hooks/useDrawer';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import {
  openDestinationForActivePane,
  openUrlInSplitPane,
} from '@/shared/lib/openInSplitPane';

/** App bar entry for the Drawer: unread count, click = page, ⌘-click = pane. */
export function AppBarDrawerContainer() {
  const appNavigation = useAppNavigation();
  const appRuntime = useAppRuntime();
  const { unreadCount, enabled } = useDrawerNotes();

  if (!enabled) return null;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey) {
      openUrlInSplitPane('/drawer', appNavigation, appRuntime);
      return;
    }
    openDestinationForActivePane(
      { kind: 'drawer' },
      appNavigation,
      appRuntime,
      () => appNavigation.goToDrawer()
    );
  };

  return (
    <Tooltip content="Drawer" side="right">
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          'relative flex items-center justify-center w-10 h-10 rounded-lg',
          'text-sm font-medium transition-colors cursor-pointer',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          'bg-panel text-normal hover:opacity-80'
        )}
        aria-label="Drawer"
      >
        <TrayIcon className="w-5 h-5" weight="bold" />
        {unreadCount > 0 && (
          <span className="absolute -top-2 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-brand-secondary text-[10px] font-medium text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
