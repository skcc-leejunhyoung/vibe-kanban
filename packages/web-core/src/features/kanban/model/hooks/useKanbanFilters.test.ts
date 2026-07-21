import { describe, expect, it } from 'vitest';
import { matchesIssueSearch } from './useKanbanFilters';

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
