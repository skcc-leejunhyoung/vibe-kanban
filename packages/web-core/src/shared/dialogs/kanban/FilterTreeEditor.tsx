import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleIcon,
  FlagIcon,
  FunnelIcon,
  PlusIcon,
  ProhibitIcon,
  StackIcon,
  TagIcon,
  TextAaIcon,
  UsersIcon,
  WarningCircleIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react';
import type {
  IssuePriority,
  ProjectMilestone,
  ProjectStatus,
  Tag,
} from 'shared/remote-types';
import type { OrganizationMemberWithProfile } from 'shared/types';
import { cn } from '@/shared/lib/utils';
import {
  ASSIGNEE_SELF,
  ASSIGNEE_UNASSIGNED,
  OPERATORS_BY_FIELD,
  OPERATOR_NEEDS_VALUES,
  addNodeToGroup,
  defaultOperatorForField,
  isConditionEffective,
  newCondition,
  newGroup,
  removeNodeById,
  updateNodeById,
  type AdvancedFilter,
  type FilterCombinator,
  type FilterCondition,
  type FilterFieldKey,
  type FilterGroup,
  type FilterNode,
  type FilterOperator,
} from '@/shared/filters/filterTree';
import { Input } from '@vibe/ui/components/Input';
import {
  MultiSelectDropdown,
  type MultiSelectDropdownOption,
} from '@vibe/ui/components/MultiSelectDropdown';
import {
  PropertyDropdown,
  type PropertyDropdownOption,
} from '@vibe/ui/components/PropertyDropdown';

const PRIORITY_VALUES: IssuePriority[] = ['urgent', 'high', 'medium', 'low'];

const PRIORITY_FALLBACK: Record<IssuePriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const getUserDisplayName = (user: OrganizationMemberWithProfile): string =>
  [user.first_name, user.last_name].filter(Boolean).join(' ') ||
  user.username ||
  'User';

const FIELD_ICON: Record<FilterFieldKey, Icon> = {
  text: TextAaIcon,
  status: CircleIcon,
  priority: WarningCircleIcon,
  assignee: UsersIcon,
  tag: TagIcon,
  milestone: FlagIcon,
  blocked: ProhibitIcon,
};

export interface FilterTreeEditorProps {
  value: AdvancedFilter;
  onChange: (next: AdvancedFilter) => void;
  statuses: ProjectStatus[];
  tags: Tag[];
  milestones: ProjectMilestone[];
  users: OrganizationMemberWithProfile[];
}

/**
 * Recursive builder for the nested AND/OR/NOT issue filter. Edits are applied
 * immutably against the root tree by node id, so a single `onChange(root)`
 * drives every nested control.
 */
export function FilterTreeEditor({
  value,
  onChange,
  statuses,
  tags,
  milestones,
  users,
}: FilterTreeEditorProps) {
  const { t } = useTranslation('common');

  const fieldLabel = useCallback(
    (field: FilterFieldKey): string =>
      ({
        text: t('kanban.filterField.text', 'Text'),
        status: t('kanban.filterField.status', 'Status'),
        priority: t('kanban.filterField.priority', 'Priority'),
        assignee: t('kanban.filterField.assignee', 'Assignee'),
        tag: t('kanban.filterField.tag', 'Tag'),
        milestone: t('kanban.filterField.milestone', 'Milestone'),
        blocked: t('kanban.filterField.blocked', 'Blocked'),
      })[field],
    [t]
  );

  const operatorLabel = useCallback(
    (operator: FilterOperator): string =>
      ({
        any_of: t('kanban.filterOp.anyOf', 'is any of'),
        none_of: t('kanban.filterOp.noneOf', 'is none of'),
        all_of: t('kanban.filterOp.allOf', 'has all of'),
        is_empty: t('kanban.filterOp.isEmpty', 'is empty'),
        is_not_empty: t('kanban.filterOp.isNotEmpty', 'is not empty'),
        contains: t('kanban.filterOp.contains', 'contains'),
        not_contains: t('kanban.filterOp.notContains', 'does not contain'),
        is_overdue: t('kanban.filterOp.isOverdue', 'is overdue'),
        is_true: t('kanban.filterOp.isTrue', 'yes'),
        is_false: t('kanban.filterOp.isFalse', 'no'),
      })[operator],
    [t]
  );

  const valueOptions = useCallback(
    (field: FilterFieldKey): MultiSelectDropdownOption<string>[] => {
      switch (field) {
        case 'status':
          return statuses.map((status) => ({
            value: status.id,
            label: status.name,
            renderOption: () => (
              <div className="flex items-center gap-base">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: status.color }}
                />
                {status.name}
              </div>
            ),
          }));
        case 'priority':
          return PRIORITY_VALUES.map((priority) => ({
            value: priority,
            label: t(
              `kanban.priorities.${priority}`,
              PRIORITY_FALLBACK[priority]
            ),
          }));
        case 'assignee':
          return [
            {
              value: ASSIGNEE_UNASSIGNED,
              label: t('kanban.unassigned', 'Unassigned'),
            },
            { value: ASSIGNEE_SELF, label: t('kanban.self', 'Me') },
            ...users.map((user) => ({
              value: user.user_id,
              label: getUserDisplayName(user),
            })),
          ];
        case 'tag':
          return tags.map((tag) => ({
            value: tag.id,
            label: tag.name,
            renderOption: () => (
              <div className="flex items-center gap-base">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
              </div>
            ),
          }));
        case 'milestone':
          return milestones.map((milestone) => ({
            value: milestone.id,
            label: milestone.name,
          }));
        default:
          return [];
      }
    },
    [statuses, tags, milestones, users, t]
  );

  const renderNode = (node: FilterNode, canRemove: boolean, depth: number) =>
    node.kind === 'group' ? (
      <GroupEditor
        key={node.id}
        node={node}
        canRemove={canRemove}
        depth={depth}
      />
    ) : (
      <ConditionRow key={node.id} node={node} />
    );

  // --- Condition row -------------------------------------------------------
  function ConditionRow({ node }: { node: FilterCondition }) {
    const patch = (next: Partial<FilterCondition>) =>
      onChange(
        updateNodeById(value, node.id, (n) => ({
          ...(n as FilterCondition),
          ...next,
        })) as AdvancedFilter
      );

    const fieldOptions: PropertyDropdownOption<FilterFieldKey>[] = (
      Object.keys(FIELD_ICON) as FilterFieldKey[]
    ).map((field) => ({ value: field, label: fieldLabel(field) }));

    const operatorOptions: PropertyDropdownOption<FilterOperator>[] =
      OPERATORS_BY_FIELD[node.field].map((operator) => ({
        value: operator,
        label: operatorLabel(operator),
      }));

    const needsValues = OPERATOR_NEEDS_VALUES[node.operator];
    const incomplete = !isConditionEffective(node);

    return (
      <div className="flex flex-wrap items-center gap-half">
        <PropertyDropdown
          value={node.field}
          options={fieldOptions}
          icon={FIELD_ICON[node.field]}
          onChange={(field) => {
            // Reset operator/values when the field changes so they stay valid.
            patch({
              field,
              operator: defaultOperatorForField(field),
              values: [],
            });
          }}
        />
        <PropertyDropdown
          value={node.operator}
          options={operatorOptions}
          onChange={(operator) =>
            patch({
              operator,
              values: OPERATOR_NEEDS_VALUES[operator] ? node.values : [],
            })
          }
        />
        {needsValues &&
          (node.field === 'text' ? (
            <Input
              value={node.values[0] ?? ''}
              placeholder={t('kanban.filterTextPlaceholder', 'Search text')}
              onChange={(event) =>
                patch({
                  values: event.target.value ? [event.target.value] : [],
                })
              }
              className="h-7 w-40 text-sm"
            />
          ) : (
            <MultiSelectDropdown
              values={node.values}
              options={valueOptions(node.field)}
              onChange={(values) => patch({ values })}
              icon={FIELD_ICON[node.field]}
              label={t('kanban.filterValues', 'Values')}
            />
          ))}
        {incomplete && (
          <span className="text-xs text-low">
            {t('kanban.filterNeedsValue', 'Pick a value (ignored until then)')}
          </span>
        )}
        <button
          type="button"
          onClick={() =>
            onChange(removeNodeById(value, node.id) as AdvancedFilter)
          }
          className="ml-auto flex items-center justify-center rounded-sm p-half text-low transition-colors hover:bg-secondary hover:text-normal"
          title={t('kanban.filterRemoveCondition', 'Remove condition')}
        >
          <XIcon className="size-icon-xs" />
        </button>
      </div>
    );
  }

  // --- Group editor --------------------------------------------------------
  function GroupEditor({
    node,
    canRemove,
    depth,
  }: {
    node: FilterGroup;
    canRemove: boolean;
    depth: number;
  }) {
    const patch = (next: Partial<FilterGroup>) =>
      onChange(
        updateNodeById(value, node.id, (n) => ({
          ...(n as FilterGroup),
          ...next,
        })) as AdvancedFilter
      );

    const combinatorOptions: PropertyDropdownOption<FilterCombinator>[] = [
      { value: 'and', label: t('kanban.filterCombinator.and', 'Match all') },
      { value: 'or', label: t('kanban.filterCombinator.or', 'Match any') },
    ];

    return (
      <div
        className={cn(
          'rounded-md border border-border bg-panel/40 p-base',
          depth > 0 && 'mt-half'
        )}
      >
        <div className="mb-base flex flex-wrap items-center gap-half">
          <PropertyDropdown
            value={node.combinator}
            options={combinatorOptions}
            icon={FunnelIcon}
            onChange={(combinator) => patch({ combinator })}
          />
          <button
            type="button"
            onClick={() => patch({ negate: !node.negate })}
            aria-pressed={node.negate}
            className={cn(
              'rounded-sm px-base py-half text-sm font-medium transition-colors',
              node.negate
                ? 'bg-brand text-white'
                : 'bg-panel text-normal hover:bg-secondary'
            )}
            title={t('kanban.filterNegateHint', 'Negate this group (NOT)')}
          >
            {t('kanban.filterNegate', 'NOT')}
          </button>
          <div className="ml-auto flex items-center gap-half">
            <button
              type="button"
              onClick={() =>
                onChange(addNodeToGroup(value, node.id, newCondition('status')))
              }
              className="flex items-center gap-half rounded-sm bg-panel px-base py-half text-sm text-normal transition-colors hover:bg-secondary"
            >
              <PlusIcon className="size-icon-xs" weight="bold" />
              {t('kanban.filterAddCondition', 'Add condition')}
            </button>
            <button
              type="button"
              onClick={() =>
                onChange(addNodeToGroup(value, node.id, newGroup('and')))
              }
              className="flex items-center gap-half rounded-sm bg-panel px-base py-half text-sm text-normal transition-colors hover:bg-secondary"
            >
              <StackIcon className="size-icon-xs" weight="bold" />
              {t('kanban.filterAddGroup', 'Add group')}
            </button>
            {canRemove && (
              <button
                type="button"
                onClick={() =>
                  onChange(removeNodeById(value, node.id) as AdvancedFilter)
                }
                className="flex items-center justify-center rounded-sm p-half text-low transition-colors hover:bg-secondary hover:text-normal"
                title={t('kanban.filterRemoveGroup', 'Remove group')}
              >
                <XIcon className="size-icon-xs" />
              </button>
            )}
          </div>
        </div>

        {node.children.length === 0 ? (
          <p className="px-half py-base text-sm text-low">
            {t('kanban.filterEmptyGroup', 'No conditions yet. Add one above.')}
          </p>
        ) : (
          <div
            className={cn(
              'flex flex-col gap-half',
              depth >= 0 && 'border-l border-border pl-base'
            )}
          >
            {node.children.map((child) => renderNode(child, true, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return <div className="flex flex-col">{renderNode(value, false, 0)}</div>;
}
