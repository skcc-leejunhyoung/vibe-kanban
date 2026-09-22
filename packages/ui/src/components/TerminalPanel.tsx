import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PlusIcon, XIcon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';

interface TerminalPanelProps {
  tabs: { id: string }[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCreateTab: () => void;
  onCloseTab: (tabId: string) => void;
  renderTab: (tabId: string, isActive: boolean) => ReactNode;
}

export function TerminalPanel({
  tabs,
  activeTabId,
  onSelectTab,
  onCreateTab,
  onCloseTab,
  renderTab,
}: TerminalPanelProps) {
  const { t } = useTranslation('common');

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-half overflow-x-auto border-b px-half py-half">
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          const label = t('terminal.session', {
            index: index + 1,
            defaultValue: 'Terminal {{index}}',
          });
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              title={label}
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onSelectTab(tab.id);
              }}
              className={cn(
                'flex shrink-0 cursor-pointer items-center gap-half rounded-sm px-base py-half text-xs',
                isActive
                  ? 'bg-panel text-high'
                  : 'text-low hover:bg-panel/60 hover:text-normal'
              )}
            >
              <span>{index + 1}</span>
              <button
                type="button"
                title={t('terminal.closeSession', {
                  defaultValue: 'Close terminal',
                })}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className="flex items-center text-low hover:text-normal"
              >
                <XIcon className="size-icon-xs" weight="bold" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          title={t('terminal.newSession', { defaultValue: 'New terminal' })}
          onClick={onCreateTab}
          className="flex shrink-0 items-center rounded-sm p-half text-low hover:bg-panel/60 hover:text-normal"
        >
          <PlusIcon className="size-icon-xs" weight="bold" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            // Inactive tabs stay mounted but hidden: their shell keeps running
            // and their scrollback survives a switch away and back.
            <div
              key={tab.id}
              className={cn('absolute inset-0', !isActive && 'hidden')}
            >
              {renderTab(tab.id, isActive)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
