import {
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowUpIcon,
} from '@phosphor-icons/react';
import { IconButton } from '@vibe/ui/components/IconButton';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_RIGHT_SIDEBAR_SECTION_ORDER,
  type RightSidebarSectionId,
} from '@/shared/lib/rightSidebarSections';

interface RightSidebarSectionOrderEditorProps {
  order: RightSidebarSectionId[];
  onChange: (order: RightSidebarSectionId[]) => void;
}

export function RightSidebarSectionOrderEditor({
  order,
  onChange,
}: RightSidebarSectionOrderEditorProps) {
  const { t } = useTranslation('settings');

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const isDefault = order.every(
    (section, index) => section === DEFAULT_RIGHT_SIDEBAR_SECTION_ORDER[index]
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-1">
        {order.map((section, index) => (
          <div
            key={section}
            className="flex items-center gap-1 rounded-sm border border-border bg-secondary px-base py-half"
          >
            <span className="flex-1 truncate text-sm text-high">
              {t(`settings.general.rightSidebar.sections.${section}`)}
            </span>
            <IconButton
              icon={ArrowUpIcon}
              onClick={() => move(index, -1)}
              disabled={index === 0}
              aria-label={t('settings.general.rightSidebar.moveUp')}
              title={t('settings.general.rightSidebar.moveUp')}
            />
            <IconButton
              icon={ArrowDownIcon}
              onClick={() => move(index, 1)}
              disabled={index === order.length - 1}
              aria-label={t('settings.general.rightSidebar.moveDown')}
              title={t('settings.general.rightSidebar.moveDown')}
            />
          </div>
        ))}
      </div>

      {!isDefault && (
        <button
          type="button"
          onClick={() => onChange([...DEFAULT_RIGHT_SIDEBAR_SECTION_ORDER])}
          className="flex items-center gap-half text-xs text-low hover:text-normal"
        >
          <ArrowCounterClockwiseIcon className="size-icon-xs" weight="bold" />
          {t('settings.general.rightSidebar.reset')}
        </button>
      )}
    </div>
  );
}
