import type { IssuePriority } from 'shared/remote-types';
import { fuzzySearchMatchAny } from '@vibe/ui/lib/search';

// --- Advanced (nested) issue-board filter model ---------------------------
//
// The simple board filter (`KanbanFilterState`) is a flat object whose fields
// are implicitly AND-ed together (OR within a field). This module adds an
// optional recursive filter tree so users can express arbitrary
// AND / OR / NOT combinations with nesting, e.g.
//   (tag = bug OR priority = urgent) AND NOT (assignee = me)
//
// Everything here is pure and client-side. The tree is persisted verbatim
// inside `KanbanFilterState.advancedFilter` (opaque JSON on the backend), so
// there is no Rust / DB / generate-types involvement. When `advancedFilter`
// is present (non-null) the board is in "advanced" mode and the flat fields
// are superseded; when it is absent the flat fields drive filtering as before.

/** Fields an individual condition can match against. */
export type FilterFieldKey =
  | 'text'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'tag'
  | 'milestone'
  | 'blocked';

/**
 * Operators available across fields. Not every operator is valid for every
 * field — see {@link OPERATORS_BY_FIELD}.
 */
export type FilterOperator =
  | 'any_of' // issue value ∈ selected (OR within the value list)
  | 'none_of' // issue value ∉ selected (negation)
  | 'all_of' // multi-valued field contains every selected value
  | 'is_empty' // field has no value (unassigned / untagged / no milestone)
  | 'is_not_empty'
  | 'contains' // text fuzzy match
  | 'not_contains'
  | 'is_overdue' // milestone target date passed and not completed
  | 'is_true' // boolean field (blocked)
  | 'is_false';

export type FilterCombinator = 'and' | 'or';

export type FilterCondition = {
  id: string;
  kind: 'condition';
  field: FilterFieldKey;
  operator: FilterOperator;
  /** Selected ids / enum values / search text. Empty for nullary operators. */
  values: string[];
};

export type FilterGroup = {
  id: string;
  kind: 'group';
  combinator: FilterCombinator;
  /** Negate (NOT) the whole group's result. */
  negate: boolean;
  children: FilterNode[];
};

export type FilterNode = FilterCondition | FilterGroup;

/** The persisted advanced filter is always rooted at a group. */
export type AdvancedFilter = FilterGroup;

// Special selectable values, mirroring the simple filter's conventions so a
// converted tree keeps identical semantics.
export const ASSIGNEE_UNASSIGNED = 'unassigned';
export const ASSIGNEE_SELF = '__self__';

// --- Field / operator metadata (drives the Phase 2 builder UI) -------------

export const FILTER_FIELDS: FilterFieldKey[] = [
  'text',
  'status',
  'priority',
  'assignee',
  'tag',
  'milestone',
  'blocked',
];

export const OPERATORS_BY_FIELD: Record<FilterFieldKey, FilterOperator[]> = {
  text: ['contains', 'not_contains'],
  status: ['any_of', 'none_of'],
  priority: ['any_of', 'none_of'],
  assignee: ['any_of', 'none_of', 'all_of', 'is_empty', 'is_not_empty'],
  tag: ['any_of', 'none_of', 'all_of', 'is_empty', 'is_not_empty'],
  milestone: ['any_of', 'none_of', 'is_empty', 'is_not_empty', 'is_overdue'],
  blocked: ['is_true', 'is_false'],
};

/** Operators that carry a value payload (need a value control in the UI). */
export const OPERATOR_NEEDS_VALUES: Record<FilterOperator, boolean> = {
  any_of: true,
  none_of: true,
  all_of: true,
  is_empty: false,
  is_not_empty: false,
  contains: true,
  not_contains: true,
  is_overdue: false,
  is_true: false,
  is_false: false,
};

export const defaultOperatorForField = (
  field: FilterFieldKey
): FilterOperator => OPERATORS_BY_FIELD[field][0];

// --- Node construction & immutable editing ---------------------------------

const newId = (): string => crypto.randomUUID();

export const newCondition = (
  field: FilterFieldKey = 'status'
): FilterCondition => ({
  id: newId(),
  kind: 'condition',
  field,
  operator: defaultOperatorForField(field),
  values: [],
});

export const newGroup = (
  combinator: FilterCombinator = 'and'
): FilterGroup => ({
  id: newId(),
  kind: 'group',
  combinator,
  negate: false,
  children: [],
});

/** Returns a new tree with the node matching `id` replaced by `updater`'s result. */
export const updateNodeById = (
  root: FilterNode,
  id: string,
  updater: (node: FilterNode) => FilterNode
): FilterNode => {
  if (root.id === id) return updater(root);
  if (root.kind !== 'group') return root;
  let changed = false;
  const children = root.children.map((child) => {
    const next = updateNodeById(child, id, updater);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
};

/** Returns a new tree with the node matching `id` removed (root is never removed). */
export const removeNodeById = (root: FilterGroup, id: string): FilterGroup => {
  const children = root.children
    .filter((child) => child.id !== id)
    .map((child) =>
      child.kind === 'group' ? removeNodeById(child, id) : child
    );
  return { ...root, children };
};

/** Returns a new tree with `node` appended to the group matching `groupId`. */
export const addNodeToGroup = (
  root: FilterGroup,
  groupId: string,
  node: FilterNode
): FilterGroup =>
  updateNodeById(root, groupId, (group) =>
    group.kind === 'group'
      ? { ...group, children: [...group.children, node] }
      : group
  ) as FilterGroup;

// --- Activity & equality ---------------------------------------------------

/**
 * A condition is "effective" only when it can actually constrain results: a
 * nullary operator (is_empty, is_overdue, …) always is, while a value-taking
 * operator needs at least one non-blank value. An ineffective condition is a
 * half-built row and is ignored during evaluation so it never blanks the board.
 */
export const isConditionEffective = (condition: FilterCondition): boolean =>
  !OPERATOR_NEEDS_VALUES[condition.operator] ||
  condition.values.some((value) => value.trim() !== '');

/** True when the tree contains at least one effective condition. */
export const isAdvancedFilterActive = (
  filter: AdvancedFilter | null | undefined
): boolean => {
  if (!filter) return false;
  const hasEffective = (node: FilterNode): boolean =>
    node.kind === 'condition'
      ? isConditionEffective(node)
      : node.children.some(hasEffective);
  return filter.children.some(hasEffective);
};

/** Strip volatile ids so two trees can be compared structurally. */
const stripIds = (node: FilterNode): unknown =>
  node.kind === 'condition'
    ? {
        kind: 'condition',
        field: node.field,
        operator: node.operator,
        values: [...node.values].sort(),
      }
    : {
        kind: 'group',
        combinator: node.combinator,
        negate: node.negate,
        children: node.children.map(stripIds),
      };

export const areAdvancedFiltersEqual = (
  a: AdvancedFilter | null | undefined,
  b: AdvancedFilter | null | undefined
): boolean => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(stripIds(a)) === JSON.stringify(stripIds(b));
};

// --- Evaluation ------------------------------------------------------------

/** Normalized per-issue facts the evaluator needs. Cheap to build in the hook. */
export type IssueFilterFacts = {
  statusId: string;
  priority: IssuePriority | null;
  assigneeUserIds: string[];
  tagIds: string[];
  milestoneId: string | null;
  isMilestoneOverdue: boolean;
  isBlocked: boolean;
  text: {
    title: string;
    description: string | null;
    simpleId: string;
    issueNumber: number;
  };
};

export type FilterEvalOptions = {
  /** Resolves the `__self__` assignee token; null when no user is signed in. */
  currentUserId: string | null;
};

const resolveAssigneeSelection = (
  values: string[],
  currentUserId: string | null
): { userIds: Set<string>; includeUnassigned: boolean } => {
  const userIds = new Set<string>();
  let includeUnassigned = false;
  for (const value of values) {
    if (value === ASSIGNEE_UNASSIGNED) {
      includeUnassigned = true;
    } else if (value === ASSIGNEE_SELF) {
      if (currentUserId) userIds.add(currentUserId);
    } else {
      userIds.add(value);
    }
  }
  return { userIds, includeUnassigned };
};

const evaluateCondition = (
  condition: FilterCondition,
  facts: IssueFilterFacts,
  options: FilterEvalOptions
): boolean => {
  const { field, operator, values } = condition;

  // A half-built condition (value-taking operator with no value yet) is
  // ignored rather than excluding everything, matching the simple filter where
  // an empty selection means "no constraint".
  if (!isConditionEffective(condition)) return true;

  switch (field) {
    case 'text': {
      const query = values[0]?.trim() ?? '';
      if (!query) return true;
      const matches = fuzzySearchMatchAny(
        [
          facts.text.title,
          facts.text.description,
          facts.text.simpleId,
          String(facts.text.issueNumber),
        ],
        query
      );
      return operator === 'not_contains' ? !matches : matches;
    }
    case 'status': {
      const inSet = values.includes(facts.statusId);
      return operator === 'none_of' ? !inSet : inSet;
    }
    case 'priority': {
      const inSet = facts.priority !== null && values.includes(facts.priority);
      return operator === 'none_of' ? !inSet : inSet;
    }
    case 'assignee': {
      if (operator === 'is_empty') return facts.assigneeUserIds.length === 0;
      if (operator === 'is_not_empty') return facts.assigneeUserIds.length > 0;
      const { userIds, includeUnassigned } = resolveAssigneeSelection(
        values,
        options.currentUserId
      );
      if (operator === 'all_of') {
        return (
          [...userIds].every((id) => facts.assigneeUserIds.includes(id)) &&
          (!includeUnassigned || facts.assigneeUserIds.length === 0)
        );
      }
      const matchesAny =
        (includeUnassigned && facts.assigneeUserIds.length === 0) ||
        facts.assigneeUserIds.some((id) => userIds.has(id));
      return operator === 'none_of' ? !matchesAny : matchesAny;
    }
    case 'tag': {
      if (operator === 'is_empty') return facts.tagIds.length === 0;
      if (operator === 'is_not_empty') return facts.tagIds.length > 0;
      if (operator === 'all_of') {
        return values.every((id) => facts.tagIds.includes(id));
      }
      const matchesAny = facts.tagIds.some((id) => values.includes(id));
      return operator === 'none_of' ? !matchesAny : matchesAny;
    }
    case 'milestone': {
      if (operator === 'is_empty') return facts.milestoneId === null;
      if (operator === 'is_not_empty') return facts.milestoneId !== null;
      if (operator === 'is_overdue') return facts.isMilestoneOverdue;
      const inSet =
        facts.milestoneId !== null && values.includes(facts.milestoneId);
      return operator === 'none_of' ? !inSet : inSet;
    }
    case 'blocked':
      return operator === 'is_false' ? !facts.isBlocked : facts.isBlocked;
    default:
      return true;
  }
};

/**
 * Evaluate a filter node against a single issue's facts. Empty groups match
 * everything (so a half-built filter never hides all issues); an empty group
 * wrapped in `negate` therefore matches nothing.
 */
export const evaluateNode = (
  node: FilterNode,
  facts: IssueFilterFacts,
  options: FilterEvalOptions
): boolean => {
  if (node.kind === 'condition') {
    return evaluateCondition(node, facts, options);
  }
  let result: boolean;
  if (node.children.length === 0) {
    result = true;
  } else if (node.combinator === 'and') {
    result = node.children.every((child) =>
      evaluateNode(child, facts, options)
    );
  } else {
    result = node.children.some((child) => evaluateNode(child, facts, options));
  }
  return node.negate ? !result : result;
};

// --- Migration from the flat simple filter ---------------------------------

/** Minimal shape of the flat filter needed to seed an advanced tree. */
export type SimpleFilterInput = {
  searchQuery: string;
  priorities: IssuePriority[];
  assigneeIds: string[];
  tagIds: string[];
  milestoneIds: string[];
  overdue: boolean;
};

const MILESTONE_NONE = '__no_milestone__';

/**
 * Loss-lessly convert the current flat filter into a canonical AND group so
 * switching to advanced mode seeds the builder with the same result set.
 */
export const buildTreeFromSimpleFilters = (
  simple: SimpleFilterInput
): AdvancedFilter => {
  const root = newGroup('and');
  const children: FilterNode[] = [];

  const query = simple.searchQuery.trim();
  if (query) {
    children.push({
      ...newCondition('text'),
      operator: 'contains',
      values: [query],
    });
  }
  if (simple.priorities.length > 0) {
    children.push({
      ...newCondition('priority'),
      operator: 'any_of',
      values: [...simple.priorities],
    });
  }
  if (simple.assigneeIds.length > 0) {
    children.push({
      ...newCondition('assignee'),
      operator: 'any_of',
      values: [...simple.assigneeIds],
    });
  }
  if (simple.tagIds.length > 0) {
    children.push({
      ...newCondition('tag'),
      operator: 'any_of',
      values: [...simple.tagIds],
    });
  }

  const milestoneIds = simple.milestoneIds ?? [];
  const includeNone = milestoneIds.includes(MILESTONE_NONE);
  const realMilestoneIds = milestoneIds.filter((id) => id !== MILESTONE_NONE);
  if (includeNone && realMilestoneIds.length > 0) {
    // "no milestone OR one of these" — an OR sub-group.
    const orGroup = newGroup('or');
    orGroup.children.push(
      {
        ...newCondition('milestone'),
        operator: 'any_of',
        values: realMilestoneIds,
      },
      { ...newCondition('milestone'), operator: 'is_empty', values: [] }
    );
    children.push(orGroup);
  } else if (includeNone) {
    children.push({
      ...newCondition('milestone'),
      operator: 'is_empty',
      values: [],
    });
  } else if (realMilestoneIds.length > 0) {
    children.push({
      ...newCondition('milestone'),
      operator: 'any_of',
      values: realMilestoneIds,
    });
  }

  if (simple.overdue) {
    children.push({
      ...newCondition('milestone'),
      operator: 'is_overdue',
      values: [],
    });
  }

  return { ...root, children };
};
