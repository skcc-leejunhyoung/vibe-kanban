import { describe, expect, it } from 'vitest';

import {
  gitBranchId,
  renderBranchTemplate,
  resolveAutoWorkingBranchName,
} from './workingBranch';

describe('gitBranchId', () => {
  it('keeps ASCII behaviour (lowercase, hyphenated, capped at 16 chars)', () => {
    expect(gitBranchId('Fix the login bug')).toBe('fix-the-login-bu');
  });

  it('preserves Hangul titles instead of wiping the slug', () => {
    expect(gitBranchId('로그인 버그 수정')).toBe('로그인-버그-수정');
  });

  it('keeps mixed scripts and strips git-illegal punctuation', () => {
    expect(gitBranchId('버그 fix #123!')).toBe('버그-fix-123');
  });

  it('collapses characters git refs forbid into single hyphens', () => {
    expect(gitBranchId('a~b:c?d*e')).toBe('a-b-c-d-e');
  });

  it('returns an empty slug for symbol-only titles', () => {
    expect(gitBranchId('!@#$%')).toBe('');
  });
});

describe('renderBranchTemplate', () => {
  it('renders a Hangul issue title into the branch template', () => {
    expect(
      renderBranchTemplate('{issueNumber}-{issueTitle}', {
        issueNumber: 'VK-12',
        issueTitle: '로그인 버그 수정',
      })
    ).toBe('VK-12-로그인-버그-수정');
  });

  it('drops the trailing hyphen when the title sanitizes to nothing', () => {
    expect(
      renderBranchTemplate('{issueNumber}-{issueTitle}', {
        issueNumber: 'VK-12',
        issueTitle: '!!!',
      })
    ).toBe('VK-12');
  });
});

describe('resolveAutoWorkingBranchName', () => {
  it('uses the simple id and the sanitized Hangul title', () => {
    expect(
      resolveAutoWorkingBranchName('{issueNumber}-{issueTitle}', {
        simpleId: 'VK-12',
        title: '로그인 버그 수정',
      })
    ).toBe('VK-12-로그인-버그-수정');
  });
});
