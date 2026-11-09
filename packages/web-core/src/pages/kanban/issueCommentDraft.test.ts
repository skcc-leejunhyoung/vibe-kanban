import { describe, expect, it } from 'vitest';
import { getIssueCommentDraftId } from './issueCommentDraft';

const issueId = '11111111-2222-4333-8444-555555555555';

describe('issue comment scratch IDs', () => {
  it('uses the issue UUID for local API and stream requests', () => {
    const id = getIssueCommentDraftId(issueId, 'local');
    expect(id).toBe(issueId);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(
      getIssueCommentDraftId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'local')
    ).not.toBe(id);
  });

  it('preserves remote localStorage keys so existing drafts still load', () => {
    expect(getIssueCommentDraftId(issueId, 'remote')).toBe(
      `issue-comment:${issueId}`
    );
  });
});
