import { describe, expect, it } from 'vitest';
import {
  ASSIGNEE_SELF,
  ASSIGNEE_UNASSIGNED,
  addNodeToGroup,
  areAdvancedFiltersEqual,
  buildTreeFromSimpleFilters,
  evaluateNode,
  isAdvancedFilterActive,
  isConditionEffective,
  newCondition,
  newGroup,
  removeNodeById,
  updateNodeById,
  type FilterCondition,
  type FilterGroup,
  type IssueFilterFacts,
} from './filterTree';

const baseFacts: IssueFilterFacts = {
  statusId: 's-todo',
  priority: 'high',
  assigneeUserIds: ['u1'],
  tagIds: ['t-bug'],
  milestoneId: 'm1',
  isMilestoneOverdue: false,
  isCurrentMilestone: false,
  isBlocked: false,
  text: {
    title: '로그인 플로우 개선',
    description: '인증 상태 복구',
    simpleId: 'VK-42',
    issueNumber: 42,
  },
};

const facts = (over: Partial<IssueFilterFacts> = {}): IssueFilterFacts => ({
  ...baseFacts,
  ...over,
});

const cond = (c: Partial<FilterCondition>): FilterCondition => ({
  ...newCondition(),
  ...c,
});

const group = (
  combinator: 'and' | 'or',
  children: FilterGroup['children'],
  negate = false
): FilterGroup => ({ ...newGroup(combinator), negate, children });

const opts = { currentUserId: 'u-self' };

describe('evaluateNode — single conditions', () => {
  it('status any_of / none_of', () => {
    expect(
      evaluateNode(
        cond({ field: 'status', operator: 'any_of', values: ['s-todo'] }),
        facts(),
        opts
      )
    ).toBe(true);
    expect(
      evaluateNode(
        cond({ field: 'status', operator: 'none_of', values: ['s-todo'] }),
        facts(),
        opts
      )
    ).toBe(false);
    expect(
      evaluateNode(
        cond({ field: 'status', operator: 'none_of', values: ['s-done'] }),
        facts(),
        opts
      )
    ).toBe(true);
  });

  it('priority handles null for none_of', () => {
    expect(
      evaluateNode(
        cond({ field: 'priority', operator: 'any_of', values: ['high'] }),
        facts(),
        opts
      )
    ).toBe(true);
    expect(
      evaluateNode(
        cond({ field: 'priority', operator: 'none_of', values: ['high'] }),
        facts({ priority: null }),
        opts
      )
    ).toBe(true);
  });

  it('tag all_of requires every value present', () => {
    const f = facts({ tagIds: ['t-bug', 't-ui'] });
    expect(
      evaluateNode(
        cond({ field: 'tag', operator: 'all_of', values: ['t-bug', 't-ui'] }),
        f,
        opts
      )
    ).toBe(true);
    expect(
      evaluateNode(
        cond({ field: 'tag', operator: 'all_of', values: ['t-bug', 't-x'] }),
        f,
        opts
      )
    ).toBe(false);
  });

  it('tag is_empty / is_not_empty', () => {
    expect(
      evaluateNode(
        cond({ field: 'tag', operator: 'is_empty', values: [] }),
        facts({ tagIds: [] }),
        opts
      )
    ).toBe(true);
    expect(
      evaluateNode(
        cond({ field: 'tag', operator: 'is_not_empty', values: [] }),
        facts(),
        opts
      )
    ).toBe(true);
  });

  it('assignee resolves __self__ and unassigned', () => {
    expect(
      evaluateNode(
        cond({
          field: 'assignee',
          operator: 'any_of',
          values: [ASSIGNEE_SELF],
        }),
        facts({ assigneeUserIds: ['u-self'] }),
        opts
      )
    ).toBe(true);
    expect(
      evaluateNode(
        cond({
          field: 'assignee',
          operator: 'any_of',
          values: [ASSIGNEE_UNASSIGNED],
        }),
        facts({ assigneeUserIds: [] }),
        opts
      )
    ).toBe(true);
    expect(
      evaluateNode(
        cond({ field: 'assignee', operator: 'none_of', values: ['u1'] }),
        facts({ assigneeUserIds: ['u1'] }),
        opts
      )
    ).toBe(false);
  });

  it('milestone is_empty / is_overdue / is_current', () => {
    expect(
      evaluateNode(
        cond({ field: 'milestone', operator: 'is_empty', values: [] }),
        facts({ milestoneId: null }),
        opts
      )
    ).toBe(true);
    expect(
      evaluateNode(
        cond({ field: 'milestone', operator: 'is_overdue', values: [] }),
        facts({ isMilestoneOverdue: true }),
        opts
      )
    ).toBe(true);
    expect(
      evaluateNode(
        cond({ field: 'milestone', operator: 'is_current', values: [] }),
        facts({ isCurrentMilestone: true }),
        opts
      )
    ).toBe(true);
    expect(
      evaluateNode(
        cond({ field: 'milestone', operator: 'is_current', values: [] }),
        facts({ isCurrentMilestone: false }),
        opts
      )
    ).toBe(false);
  });

  it('per-condition negate inverts an effective condition only', () => {
    // NOT (status any_of s-todo) excludes matching issues.
    expect(
      evaluateNode(
        cond({
          field: 'status',
          operator: 'any_of',
          values: ['s-todo'],
          negate: true,
        }),
        facts(),
        opts
      )
    ).toBe(false);
    expect(
      evaluateNode(
        cond({
          field: 'status',
          operator: 'any_of',
          values: ['s-done'],
          negate: true,
        }),
        facts(),
        opts
      )
    ).toBe(true);
    // A half-built negated condition imposes no constraint (never blanks board).
    expect(
      evaluateNode(
        cond({
          field: 'status',
          operator: 'any_of',
          values: [],
          negate: true,
        }),
        facts(),
        opts
      )
    ).toBe(true);
  });

  it('text contains / not_contains (fuzzy)', () => {
    expect(
      evaluateNode(
        cond({ field: 'text', operator: 'contains', values: ['로플개'] }),
        facts(),
        opts
      )
    ).toBe(true);
    expect(
      evaluateNode(
        cond({
          field: 'text',
          operator: 'not_contains',
          values: ['존재하지않는쿼리xyz'],
        }),
        facts(),
        opts
      )
    ).toBe(true);
  });

  it('blocked is_true / is_false', () => {
    expect(
      evaluateNode(
        cond({ field: 'blocked', operator: 'is_true', values: [] }),
        facts({ isBlocked: true }),
        opts
      )
    ).toBe(true);
    expect(
      evaluateNode(
        cond({ field: 'blocked', operator: 'is_false', values: [] }),
        facts({ isBlocked: false }),
        opts
      )
    ).toBe(true);
  });
});

describe('evaluateNode — groups (AND / OR / NOT / nesting)', () => {
  const tagBug = cond({ field: 'tag', operator: 'any_of', values: ['t-bug'] });
  const prioUrgent = cond({
    field: 'priority',
    operator: 'any_of',
    values: ['urgent'],
  });
  const assigneeMe = cond({
    field: 'assignee',
    operator: 'any_of',
    values: ['u1'],
  });

  it('AND requires all children', () => {
    const f = facts({ tagIds: ['t-bug'], priority: 'high' });
    expect(evaluateNode(group('and', [tagBug, prioUrgent]), f, opts)).toBe(
      false
    );
    expect(evaluateNode(group('and', [tagBug]), f, opts)).toBe(true);
  });

  it('OR requires any child', () => {
    const f = facts({ tagIds: ['t-bug'], priority: 'high' });
    expect(evaluateNode(group('or', [tagBug, prioUrgent]), f, opts)).toBe(true);
  });

  it('NOT group inverts result', () => {
    const f = facts({ assigneeUserIds: ['u1'] });
    expect(evaluateNode(group('or', [assigneeMe], true), f, opts)).toBe(false);
  });

  it('(tag=bug OR priority=urgent) AND NOT (assignee=u1)', () => {
    const tree = group('and', [
      group('or', [tagBug, prioUrgent]),
      group('and', [assigneeMe], true),
    ]);
    // bug tag, not assigned to u1 -> passes
    expect(
      evaluateNode(
        tree,
        facts({ tagIds: ['t-bug'], assigneeUserIds: ['u9'] }),
        opts
      )
    ).toBe(true);
    // bug tag but assigned to u1 -> excluded by NOT
    expect(
      evaluateNode(
        tree,
        facts({ tagIds: ['t-bug'], assigneeUserIds: ['u1'] }),
        opts
      )
    ).toBe(false);
    // neither bug nor urgent -> fails first branch
    expect(
      evaluateNode(
        tree,
        facts({ tagIds: ['t-x'], priority: 'low', assigneeUserIds: ['u9'] }),
        opts
      )
    ).toBe(false);
  });

  it('empty group matches all, even when negated (no constraint to invert)', () => {
    expect(evaluateNode(group('and', []), facts(), opts)).toBe(true);
    expect(evaluateNode(group('or', []), facts(), opts)).toBe(true);
    // A NOT wrapped around nothing still imposes no constraint: an empty group
    // can only exist mid-edit, and must never blank the board.
    expect(evaluateNode(group('and', [], true), facts(), opts)).toBe(true);
    expect(evaluateNode(group('or', [], true), facts(), opts)).toBe(true);
  });
});

describe('tree editing helpers', () => {
  it('addNodeToGroup / updateNodeById / removeNodeById are immutable', () => {
    const root = newGroup('and');
    const child = cond({
      id: 'c1',
      field: 'status',
      operator: 'any_of',
      values: ['s'],
    });
    const withChild = addNodeToGroup(root, root.id, child);
    expect(withChild).not.toBe(root);
    expect(withChild.children).toHaveLength(1);

    const updated = updateNodeById(withChild, 'c1', (n) => ({
      ...(n as FilterCondition),
      operator: 'none_of',
    })) as FilterGroup;
    expect((updated.children[0] as FilterCondition).operator).toBe('none_of');

    const removed = removeNodeById(updated, 'c1');
    expect(removed.children).toHaveLength(0);
  });
});

describe('isConditionEffective', () => {
  it('nullary operators are always effective', () => {
    expect(
      isConditionEffective(
        cond({ field: 'assignee', operator: 'is_empty', values: [] })
      )
    ).toBe(true);
    expect(
      isConditionEffective(
        cond({ field: 'milestone', operator: 'is_overdue', values: [] })
      )
    ).toBe(true);
  });

  it('value operators need a non-blank value', () => {
    expect(
      isConditionEffective(
        cond({ field: 'status', operator: 'any_of', values: [] })
      )
    ).toBe(false);
    expect(
      isConditionEffective(
        cond({ field: 'text', operator: 'contains', values: ['   '] })
      )
    ).toBe(false);
    expect(
      isConditionEffective(
        cond({ field: 'status', operator: 'any_of', values: ['s'] })
      )
    ).toBe(true);
  });
});

describe('evaluateNode — incomplete conditions are ignored', () => {
  it('a value operator with no values does not exclude issues', () => {
    // status any_of [] would naively exclude everything; instead it is ignored.
    expect(
      evaluateNode(
        cond({ field: 'status', operator: 'any_of', values: [] }),
        facts(),
        opts
      )
    ).toBe(true);
    // inside an AND group it must not blank the result either
    const tree = group('and', [
      cond({ field: 'tag', operator: 'any_of', values: ['t-bug'] }),
      cond({ field: 'status', operator: 'any_of', values: [] }),
    ]);
    expect(evaluateNode(tree, facts({ tagIds: ['t-bug'] }), opts)).toBe(true);
  });

  it('an incomplete condition inside a NOT group does not blank the board', () => {
    // A negated group whose only child is half-built has no constraint to
    // invert, so it passes through instead of excluding every issue.
    const negatedIncomplete = group(
      'and',
      [cond({ field: 'status', operator: 'any_of', values: [] })],
      true
    );
    expect(evaluateNode(negatedIncomplete, facts(), opts)).toBe(true);

    // The real-world trigger: an active tree (a real status condition) with a
    // sibling NOT group that is still being built. The board must filter by the
    // real condition, not go empty.
    const tree = group('and', [
      cond({ field: 'tag', operator: 'any_of', values: ['t-bug'] }),
      group(
        'and',
        [cond({ field: 'assignee', operator: 'any_of', values: [] })],
        true
      ),
    ]);
    expect(evaluateNode(tree, facts({ tagIds: ['t-bug'] }), opts)).toBe(true);
    expect(evaluateNode(tree, facts({ tagIds: ['t-x'] }), opts)).toBe(false);

    // Once the negated condition becomes effective it constrains again.
    const complete = group(
      'and',
      [cond({ field: 'assignee', operator: 'any_of', values: ['u1'] })],
      true
    );
    expect(
      evaluateNode(complete, facts({ assigneeUserIds: ['u1'] }), opts)
    ).toBe(false);
    expect(
      evaluateNode(complete, facts({ assigneeUserIds: ['u9'] }), opts)
    ).toBe(true);
  });
});

describe('isAdvancedFilterActive', () => {
  it('false for null / empty tree, true once an effective condition exists', () => {
    expect(isAdvancedFilterActive(null)).toBe(false);
    expect(isAdvancedFilterActive(newGroup('and'))).toBe(false);
    expect(isAdvancedFilterActive(group('and', [group('or', [])]))).toBe(false);
    // a value condition with no values is not yet active
    expect(
      isAdvancedFilterActive(
        group('and', [
          cond({ field: 'status', operator: 'any_of', values: [] }),
        ])
      )
    ).toBe(false);
    expect(
      isAdvancedFilterActive(
        group('and', [cond({ field: 'status', values: ['s'] })])
      )
    ).toBe(true);
  });
});

describe('areAdvancedFiltersEqual', () => {
  it('ignores ids and value ordering', () => {
    const a = group('and', [
      cond({ id: 'x', field: 'tag', operator: 'any_of', values: ['a', 'b'] }),
    ]);
    const b = group('and', [
      cond({ id: 'y', field: 'tag', operator: 'any_of', values: ['b', 'a'] }),
    ]);
    expect(areAdvancedFiltersEqual(a, b)).toBe(true);
    expect(areAdvancedFiltersEqual(null, null)).toBe(true);
    expect(areAdvancedFiltersEqual(a, null)).toBe(false);
  });

  it('distinguishes combinator and negate', () => {
    const a = group('and', [
      cond({ field: 'tag', operator: 'any_of', values: ['a'] }),
    ]);
    const b = group('or', [
      cond({ field: 'tag', operator: 'any_of', values: ['a'] }),
    ]);
    expect(areAdvancedFiltersEqual(a, b)).toBe(false);
  });
});

describe('buildTreeFromSimpleFilters', () => {
  it('produces an equivalent AND tree', () => {
    const tree = buildTreeFromSimpleFilters({
      searchQuery: 'login',
      priorities: ['urgent'],
      assigneeIds: ['u1'],
      tagIds: ['t-bug'],
      milestoneIds: [],
      overdue: false,
    });
    expect(tree.combinator).toBe('and');
    expect(tree.children).toHaveLength(4);
    // an issue matching all simple criteria evaluates true
    const f = facts({
      priority: 'urgent',
      assigneeUserIds: ['u1'],
      tagIds: ['t-bug'],
      text: {
        title: 'login page',
        description: null,
        simpleId: 'VK-1',
        issueNumber: 1,
      },
    });
    expect(evaluateNode(tree, f, opts)).toBe(true);
  });

  it('expands no-milestone + real milestones into an OR sub-group', () => {
    const tree = buildTreeFromSimpleFilters({
      searchQuery: '',
      priorities: [],
      assigneeIds: [],
      tagIds: [],
      milestoneIds: ['__no_milestone__', 'm1'],
      overdue: false,
    });
    expect(tree.children).toHaveLength(1);
    const sub = tree.children[0] as FilterGroup;
    expect(sub.kind).toBe('group');
    expect(sub.combinator).toBe('or');
    // matches issues with m1 and issues with no milestone
    expect(evaluateNode(tree, facts({ milestoneId: 'm1' }), opts)).toBe(true);
    expect(evaluateNode(tree, facts({ milestoneId: null }), opts)).toBe(true);
    expect(evaluateNode(tree, facts({ milestoneId: 'm2' }), opts)).toBe(false);
  });

  it('maps overdue to an is_overdue condition', () => {
    const tree = buildTreeFromSimpleFilters({
      searchQuery: '',
      priorities: [],
      assigneeIds: [],
      tagIds: [],
      milestoneIds: [],
      overdue: true,
    });
    expect(tree.children).toHaveLength(1);
    expect(evaluateNode(tree, facts({ isMilestoneOverdue: true }), opts)).toBe(
      true
    );
    expect(evaluateNode(tree, facts({ isMilestoneOverdue: false }), opts)).toBe(
      false
    );
  });
});
