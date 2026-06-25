import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowCounterClockwiseIcon,
  PlusIcon,
  XIcon,
} from '@phosphor-icons/react';
import { cn } from '@/shared/lib/utils';
import { IconButton } from '@vibe/ui/components/IconButton';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';

interface WorkspaceStatusListEditorProps {
  statuses: string[];
  onChange: (statuses: string[]) => void;
  defaultStatuses: string[];
}

/**
 * Editor for the ordered status names shown in the workspace sidebar's
 * issue-grouped status view. Order is meaningful (it's the section order);
 * names are matched case-insensitively, so duplicates (ignoring case) are
 * rejected on add.
 */
export function WorkspaceStatusListEditor({
  statuses,
  onChange,
  defaultStatuses,
}: WorkspaceStatusListEditorProps) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState('');

  const addStatus = () => {
    const name = draft.trim();
    if (!name) return;
    const exists = statuses.some(
      (s) => s.trim().toLowerCase() === name.toLowerCase()
    );
    if (!exists) {
      onChange([...statuses, name]);
    }
    setDraft('');
  };

  const removeAt = (index: number) => {
    onChange(statuses.filter((_, i) => i !== index));
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= statuses.length) return;
    const next = [...statuses];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const isDefault =
    statuses.length === defaultStatuses.length &&
    statuses.every((s, i) => s === defaultStatuses[i]);

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-1">
        {statuses.length === 0 ? (
          <p className="text-sm text-low">
            {t('settings.general.workspaceList.empty')}
          </p>
        ) : (
          statuses.map((status, index) => (
            <div
              key={`${status}-${index}`}
              className="flex items-center gap-1 rounded-sm border border-border bg-secondary px-base py-half"
            >
              <span className="flex-1 truncate text-sm text-high">
                {status}
              </span>
              <IconButton
                icon={ArrowUpIcon}
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={t('settings.general.workspaceList.moveUp')}
                title={t('settings.general.workspaceList.moveUp')}
              />
              <IconButton
                icon={ArrowDownIcon}
                onClick={() => move(index, 1)}
                disabled={index === statuses.length - 1}
                aria-label={t('settings.general.workspaceList.moveDown')}
                title={t('settings.general.workspaceList.moveDown')}
              />
              <IconButton
                icon={XIcon}
                onClick={() => removeAt(index)}
                aria-label={t('settings.general.workspaceList.remove')}
                title={t('settings.general.workspaceList.remove')}
              />
            </div>
          ))
        )}
      </div>

      <div className="flex items-stretch gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addStatus();
            }
          }}
          placeholder={t('settings.general.workspaceList.addPlaceholder')}
          className={cn(
            'flex-1 bg-secondary border border-border rounded-sm px-base py-half text-sm text-high',
            'placeholder:text-low placeholder:opacity-80 focus:outline-none focus:ring-1 focus:ring-brand'
          )}
        />
        <PrimaryButton
          variant="tertiary"
          value={t('settings.general.workspaceList.add')}
          actionIcon={PlusIcon}
          onClick={addStatus}
        />
      </div>

      {!isDefault && (
        <button
          type="button"
          onClick={() => onChange([...defaultStatuses])}
          className="flex items-center gap-half text-xs text-low hover:text-normal"
        >
          <ArrowCounterClockwiseIcon className="size-icon-xs" weight="bold" />
          {t('settings.general.workspaceList.reset')}
        </button>
      )}
    </div>
  );
}
