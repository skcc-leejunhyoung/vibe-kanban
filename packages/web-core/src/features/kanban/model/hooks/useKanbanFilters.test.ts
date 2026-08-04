import { describe, expect, it } from 'vitest';
import {
  matchesIssueSearch,
  matchesMilestoneFilters,
} from './useKanbanFilters';

const issue = {
  title: '로그인 플로우 개선',
  description: '원격 호스트에서 인증 상태를 복구합니다',
  simple_id: 'VK-42',
  issue_number: 42,
};

describe('matchesIssueSearch', () => {
  it('matches fuzzy characters in the title', () => {
    expect(matchesIssueSearch(issue, '로플개')).toBe(true);
  });

  it('searches the issue body', () => {
    expect(matchesIssueSearch(issue, '호인상복')).toBe(true);
  });

  it('continues to search issue identifiers', () => {
    expect(matchesIssueSearch(issue, 'v42')).toBe(true);
  });
});

describe('matchesMilestoneFilters', () => {
  const milestone = {
    id: 'm1',
    target_date: '2026-08-01T00:00:00.000Z',
    completed_at: null,
  };

  it('matches selected milestone IDs', () => {
    expect(matchesMilestoneFilters(milestone, ['m1'], false)).toBe(true);
    expect(matchesMilestoneFilters(milestone, ['m2'], false)).toBe(false);
  });

  it('only treats incomplete past milestones as overdue', () => {
    const now = Date.parse('2026-08-04T00:00:00.000Z');
    expect(matchesMilestoneFilters(milestone, [], true, now)).toBe(true);
    expect(
      matchesMilestoneFilters(
        { ...milestone, completed_at: '2026-08-02T00:00:00.000Z' },
        [],
        true,
        now
      )
    ).toBe(false);
  });
});
