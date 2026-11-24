import { expect, it } from 'vitest';

import { adjacentIssueId } from './kanbanIssueNavigation';

it('steps to the neighbor in board order and stops at the ends', () => {
  const ids = ['a', 'b', 'c'];
  expect(adjacentIssueId(ids, 'b', 1)).toBe('c');
  expect(adjacentIssueId(ids, 'b', -1)).toBe('a');
  expect(adjacentIssueId(ids, 'c', 1)).toBeNull();
  expect(adjacentIssueId(ids, 'a', -1)).toBeNull();
  expect(adjacentIssueId(ids, 'x', 1)).toBeNull();
});
