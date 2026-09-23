import { describe, expect, it } from 'vitest';
import type { IssueTag } from 'shared/remote-types';
import { planTagToggle } from './TagSelectionDialog';

const link = (id: string, issueId: string): IssueTag => ({
  id,
  issue_id: issueId,
  tag_id: 'tag-1',
  project_id: 'p',
});

describe('planTagToggle', () => {
  const issueIds = ['a', 'b', 'c'];

  it('adds the tag only to issues that lack it', () => {
    expect(planTagToggle([link('l1', 'a')], issueIds, 'add')).toEqual({
      removeLinkIds: [],
      addIssueIds: ['b', 'c'],
    });
  });

  it('clears a tag every selected issue already has', () => {
    const links = issueIds.map((id) => link(`l-${id}`, id));
    expect(planTagToggle(links, issueIds, 'add')).toEqual({
      removeLinkIds: ['l-a', 'l-b', 'l-c'],
      addIssueIds: [],
    });
  });

  it('remove mode drops a partially applied tag from all issues', () => {
    expect(
      planTagToggle([link('l1', 'a'), link('l2', 'c')], issueIds, 'remove')
    ).toEqual({ removeLinkIds: ['l1', 'l2'], addIssueIds: [] });
  });
});
