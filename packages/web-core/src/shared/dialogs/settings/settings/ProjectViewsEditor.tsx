import { useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PlusIcon,
  XIcon,
  PencilSimpleLineIcon,
  CaretUpIcon,
  CaretDownIcon,
  KanbanIcon,
  TableIcon,
} from '@phosphor-icons/react';
import { Switch } from '@vibe/ui/components/Switch';
import { StatusDot } from '@vibe/ui/components/StatusDot';
import { cn } from '@/shared/lib/utils';
import type { IssuePriority } from 'shared/remote-types';
import {
  useUiPreferencesStore,
  buildDefaultProjectViews,
  DEFAULT_KANBAN_FILTER_STATE,
  DEFAULT_KANBAN_SHOW_WORKSPACES,
  DEFAULT_KANBAN_HIDE_BLOCKED,
  type ProjectViewDefinition,
  type ProjectViewLayout,
  type KanbanSortField,
} from '@/shared/stores/useUiPreferencesStore';

interface ViewStatus {
  id: string;
  name: string;
  color: string;
  hidden: boolean;
}

interface ProjectViewsEditorProps {
  projectId: string;
  statuses: ViewStatus[];
}

const SORT_FIELDS: KanbanSortField[] = [
  'sort_order',
  'priority',
  'created_at',
  'updated_at',
  'title',
];

const PRIORITIES: IssuePriority[] = ['urgent', 'high', 'medium', 'low'];

// Matches the label set used by PriorityFilterDropdown. Not routed through
// i18n: `kanban.priority` is already a translated string key ("Priority")
// elsewhere, so nesting per-level keys under it would collide.
const PRIORITY_LABELS: Record<IssuePriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Per-project editor for user-defined views: add / rename / delete / reorder,
 * and per-view layout, group visibility+order, and default filters/sort.
 * Changes persist immediately to the UI-preferences scratch store.
 */
export function ProjectViewsEditor({
  projectId,
  statuses,
}: ProjectViewsEditorProps) {
  const { t } = useTranslation('common');
  const storedViews = useUiPreferencesStore(
    (s) => s.projectViewsById[projectId]
  );
  const setProjectViews = useUiPreferencesStore((s) => s.setProjectViews);

  const views = useMemo(() => {
    if (storedViews && storedViews.length > 0) return storedViews;
    return buildDefaultProjectViews(statuses, {
      active: t('kanban.viewTabs.active', 'Active'),
      all: t('kanban.viewTabs.all', 'All'),
    });
  }, [storedViews, statuses, t]);

  const [editingId, setEditingId] = useState<string | null>(null);

  const persist = useCallback(
    (next: ProjectViewDefinition[]) => setProjectViews(projectId, next),
    [projectId, setProjectViews]
  );

  const updateView = useCallback(
    (id: string, patch: Partial<ProjectViewDefinition>) => {
      persist(views.map((v) => (v.id === id ? { ...v, ...patch } : v)));
    },
    [views, persist]
  );

  const deleteView = useCallback(
    (id: string) => {
      if (views.length <= 1) return; // keep at least one view
      persist(views.filter((v) => v.id !== id));
      if (editingId === id) setEditingId(null);
    },
    [views, persist, editingId]
  );

  const moveView = useCallback(
    (id: string, direction: -1 | 1) => {
      const index = views.findIndex((v) => v.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= views.length) return;
      const next = [...views];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      persist(next);
    },
    [views, persist]
  );

  const addView = useCallback(() => {
    const id = crypto.randomUUID();
    const newView: ProjectViewDefinition = {
      id,
      name: t('kanban.viewsEditor.newView', 'New view'),
      layout: 'table',
      groupStatusIds: null,
      filters: { ...DEFAULT_KANBAN_FILTER_STATE },
      showSubIssues: true,
      showWorkspaces: DEFAULT_KANBAN_SHOW_WORKSPACES,
      hideBlocked: DEFAULT_KANBAN_HIDE_BLOCKED,
    };
    persist([...views, newView]);
    setEditingId(id);
  }, [views, persist, t]);

  return (
    <div className="bg-secondary/50 border border-border rounded-sm p-4 space-y-base">
      <div>
        <p className="text-sm font-medium text-normal">
          {t('kanban.viewsEditor.label', 'Project Views')}
        </p>
        <p className="text-sm text-low mt-1">
          {t(
            'kanban.viewsEditor.description',
            'Add, edit and reorder the views shown on the project page.'
          )}
        </p>
      </div>

      <div className="flex flex-col gap-half">
        {views.map((view, index) => (
          <div key={view.id} className="rounded-sm bg-secondary">
            <div className="flex items-center gap-base px-base py-half">
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => moveView(view.id, -1)}
                  disabled={index === 0}
                  className="text-low hover:text-normal disabled:opacity-30"
                  title={t('kanban.viewsEditor.moveUp', 'Move up')}
                >
                  <CaretUpIcon className="size-icon-2xs" weight="bold" />
                </button>
                <button
                  type="button"
                  onClick={() => moveView(view.id, 1)}
                  disabled={index === views.length - 1}
                  className="text-low hover:text-normal disabled:opacity-30"
                  title={t('kanban.viewsEditor.moveDown', 'Move down')}
                >
                  <CaretDownIcon className="size-icon-2xs" weight="bold" />
                </button>
              </div>
              {view.layout === 'kanban' ? (
                <KanbanIcon className="size-icon-xs text-low" weight="bold" />
              ) : (
                <TableIcon className="size-icon-xs text-low" weight="bold" />
              )}
              <span className="text-sm text-high flex-1 truncate">
                {view.name}
              </span>
              <button
                type="button"
                onClick={() =>
                  setEditingId((cur) => (cur === view.id ? null : view.id))
                }
                className="flex items-center justify-center size-icon-sm text-low hover:text-normal"
                title={t('kanban.viewsEditor.edit', 'Edit view')}
              >
                <PencilSimpleLineIcon className="size-icon-xs" weight="bold" />
              </button>
              <button
                type="button"
                onClick={() => deleteView(view.id)}
                disabled={views.length <= 1}
                className="flex items-center justify-center size-icon-sm text-low hover:text-normal disabled:opacity-30"
                title={t('kanban.viewsEditor.delete', 'Delete view')}
              >
                <XIcon className="size-icon-xs" weight="bold" />
              </button>
            </div>

            {editingId === view.id && (
              <ViewEditorPanel
                key={view.id}
                view={view}
                statuses={statuses}
                onChange={(patch) => updateView(view.id, patch)}
              />
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addView}
        className="flex items-center gap-half px-base py-half text-high hover:bg-secondary rounded-sm transition-colors"
      >
        <div className="flex items-center justify-center size-icon-sm">
          <PlusIcon className="size-icon-xs" weight="bold" />
        </div>
        <span className="text-xs font-light">
          {t('kanban.viewsEditor.addView', 'Add view')}
        </span>
      </button>
    </div>
  );
}

interface ViewEditorPanelProps {
  view: ProjectViewDefinition;
  statuses: ViewStatus[];
  onChange: (patch: Partial<ProjectViewDefinition>) => void;
}

function ViewEditorPanel({ view, statuses, onChange }: ViewEditorPanelProps) {
  const { t } = useTranslation('common');

  // Local ordered/checked group state so unchecked statuses keep their place
  // while editing. Seeded from the view; explicit groupStatusIds is derived on
  // every change (checked ids in order).
  const defaultChecked = useCallback(
    (statusId: string, hidden: boolean) => {
      if (view.groupStatusIds) return view.groupStatusIds.includes(statusId);
      return view.layout === 'kanban' ? !hidden : true;
    },
    [view.groupStatusIds, view.layout]
  );

  const initialOrder = useMemo(() => {
    const ids = statuses.map((s) => s.id);
    if (!view.groupStatusIds) return ids;
    const ordered = view.groupStatusIds.filter((id) => ids.includes(id));
    const rest = ids.filter((id) => !ordered.includes(id));
    return [...ordered, ...rest];
  }, [statuses, view.groupStatusIds]);

  const [groupOrder, setGroupOrder] = useState<string[]>(initialOrder);
  const [checked, setChecked] = useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const s of statuses) {
      if (defaultChecked(s.id, s.hidden)) set.add(s.id);
    }
    return set;
  });

  // Keep local order in sync when the project's status set changes.
  useEffect(() => {
    setGroupOrder((prev) => {
      const ids = statuses.map((s) => s.id);
      const kept = prev.filter((id) => ids.includes(id));
      const added = ids.filter((id) => !kept.includes(id));
      return [...kept, ...added];
    });
  }, [statuses]);

  const statusById = useMemo(() => {
    const map = new Map<string, ViewStatus>();
    for (const s of statuses) map.set(s.id, s);
    return map;
  }, [statuses]);

  const commitGroups = useCallback(
    (order: string[], checkedSet: Set<string>) => {
      onChange({ groupStatusIds: order.filter((id) => checkedSet.has(id)) });
    },
    [onChange]
  );

  const toggleGroup = useCallback(
    (statusId: string) => {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(statusId)) next.delete(statusId);
        else next.add(statusId);
        commitGroups(groupOrder, next);
        return next;
      });
    },
    [groupOrder, commitGroups]
  );

  const moveGroup = useCallback(
    (statusId: string, direction: -1 | 1) => {
      setGroupOrder((prev) => {
        const index = prev.indexOf(statusId);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= prev.length) return prev;
        const next = [...prev];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);
        commitGroups(next, checked);
        return next;
      });
    },
    [checked, commitGroups]
  );

  const togglePriority = useCallback(
    (priority: IssuePriority) => {
      const current = view.filters.priorities;
      const next = current.includes(priority)
        ? current.filter((p) => p !== priority)
        : [...current, priority];
      onChange({ filters: { ...view.filters, priorities: next } });
    },
    [view.filters, onChange]
  );

  return (
    <div className="px-base pb-base pt-half space-y-base border-t border-border">
      {/* Name */}
      <label className="flex flex-col gap-half">
        <span className="text-xs text-low">
          {t('kanban.viewsEditor.name', 'Name')}
        </span>
        <input
          type="text"
          value={view.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="bg-panel border border-border rounded-sm px-base py-half text-sm text-high focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </label>

      {/* Layout */}
      <div className="flex flex-col gap-half">
        <span className="text-xs text-low">
          {t('kanban.viewsEditor.layout', 'Layout')}
        </span>
        <div className="flex gap-half">
          {(['kanban', 'table'] as ProjectViewLayout[]).map((layout) => (
            <button
              key={layout}
              type="button"
              onClick={() => onChange({ layout })}
              className={cn(
                'flex items-center gap-half px-base py-half rounded-sm border text-sm transition-colors',
                view.layout === layout
                  ? 'border-brand text-high bg-panel'
                  : 'border-border text-low hover:text-normal'
              )}
            >
              {layout === 'kanban' ? (
                <KanbanIcon className="size-icon-xs" weight="bold" />
              ) : (
                <TableIcon className="size-icon-xs" weight="bold" />
              )}
              {layout === 'kanban'
                ? t('kanban.viewsEditor.layoutKanban', 'Board')
                : t('kanban.viewsEditor.layoutTable', 'Table')}
            </button>
          ))}
        </div>
      </div>

      {/* Groups */}
      <div className="flex flex-col gap-half">
        <span className="text-xs text-low">
          {t('kanban.viewsEditor.groups', 'Groups (visibility & order)')}
        </span>
        <div className="flex flex-col gap-[2px]">
          {groupOrder.map((statusId, index) => {
            const status = statusById.get(statusId);
            if (!status) return null;
            return (
              <div
                key={statusId}
                className="flex items-center gap-base px-base py-half rounded-sm bg-panel"
              >
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => moveGroup(statusId, -1)}
                    disabled={index === 0}
                    className="text-low hover:text-normal disabled:opacity-30"
                  >
                    <CaretUpIcon className="size-icon-2xs" weight="bold" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveGroup(statusId, 1)}
                    disabled={index === groupOrder.length - 1}
                    className="text-low hover:text-normal disabled:opacity-30"
                  >
                    <CaretDownIcon className="size-icon-2xs" weight="bold" />
                  </button>
                </div>
                <StatusDot color={status.color} />
                <span className="text-sm text-high flex-1 truncate">
                  {status.name}
                </span>
                <Switch
                  checked={checked.has(statusId)}
                  onCheckedChange={() => toggleGroup(statusId)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Sort */}
      <div className="flex flex-col gap-half">
        <span className="text-xs text-low">
          {t('kanban.viewsEditor.sort', 'Default sort')}
        </span>
        <div className="flex items-center gap-half">
          <select
            value={view.filters.sortField}
            onChange={(e) =>
              onChange({
                filters: {
                  ...view.filters,
                  sortField: e.target.value as KanbanSortField,
                },
              })
            }
            className="bg-panel border border-border rounded-sm px-base py-half text-sm text-high focus:outline-none focus:ring-1 focus:ring-brand"
          >
            {SORT_FIELDS.map((field) => (
              <option key={field} value={field}>
                {t(`kanban.viewsEditor.sortField.${field}`, field)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              onChange({
                filters: {
                  ...view.filters,
                  sortDirection:
                    view.filters.sortDirection === 'asc' ? 'desc' : 'asc',
                },
              })
            }
            className="px-base py-half rounded-sm border border-border text-sm text-low hover:text-normal"
          >
            {view.filters.sortDirection === 'asc'
              ? t('kanban.viewsEditor.ascending', 'Ascending')
              : t('kanban.viewsEditor.descending', 'Descending')}
          </button>
        </div>
      </div>

      {/* Default priority filter */}
      <div className="flex flex-col gap-half">
        <span className="text-xs text-low">
          {t('kanban.viewsEditor.priorityFilter', 'Default priority filter')}
        </span>
        <div className="flex flex-wrap gap-half">
          {PRIORITIES.map((priority) => (
            <button
              key={priority}
              type="button"
              onClick={() => togglePriority(priority)}
              className={cn(
                'px-base py-half rounded-sm border text-sm capitalize transition-colors',
                view.filters.priorities.includes(priority)
                  ? 'border-brand text-high bg-panel'
                  : 'border-border text-low hover:text-normal'
              )}
            >
              {PRIORITY_LABELS[priority]}
            </button>
          ))}
        </div>
      </div>

      {/* Toggles */}
      <div className="flex flex-col gap-half">
        <ToggleRow
          label={t('kanban.viewsEditor.showSubIssues', 'Show sub-issues')}
          checked={view.showSubIssues}
          onChange={(v) => onChange({ showSubIssues: v })}
        />
        <ToggleRow
          label={t('kanban.viewsEditor.showWorkspaces', 'Show workspaces')}
          checked={view.showWorkspaces}
          onChange={(v) => onChange({ showWorkspaces: v })}
        />
        <ToggleRow
          label={t('kanban.viewsEditor.hideBlocked', 'Hide blocked issues')}
          checked={view.hideBlocked}
          onChange={(v) => onChange({ hideBlocked: v })}
        />
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between px-base py-half rounded-sm bg-panel">
      <span className="text-sm text-normal">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
