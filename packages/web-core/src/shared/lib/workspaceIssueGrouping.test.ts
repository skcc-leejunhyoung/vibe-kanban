import { describe, it, expect } from 'vitest';
import {
  groupWorkspacesByIssue,
  bucketIssueGroupsByStatus,
  UNLINKED_GROUP_KEY,
  UNKNOWN_STATUS_KEY,
  type WorkspaceIssueMeta,
} from './workspaceIssueGrouping';

const ws = (id: string, hostId = 'host-a') => ({ id, name: id, hostId });
const key = (id: string, hostId = 'host-a') => `${hostId}:${id}`;

function meta(issueId: string, statusName: string | null): WorkspaceIssueMeta {
  return {
    issueId,
    statusName,
    header: {
      displayId: `#${issueId}`,
      title: issueId,
      projectName: 'Proj',
      projectColor: null,
      statusName,
      statusColor: null,
      tags: [],
    },
  };
}

describe('groupWorkspacesByIssue', () => {
  it('groups workspaces under their issue in first-seen order', () => {
    const groups = groupWorkspacesByIssue(
      [ws('a'), ws('b'), ws('c')],
      new Map<string, WorkspaceIssueMeta | null>([
        [key('a'), meta('I1', 'To do')],
        [key('b'), meta('I2', 'Done')],
        [key('c'), meta('I1', 'To do')],
      ])
    );
    expect(groups.map((g) => g.key)).toEqual(['I1', 'I2']);
    expect(groups[0].workspaces.map((w) => w.id)).toEqual(['a', 'c']);
    expect(groups[1].workspaces.map((w) => w.id)).toEqual(['b']);
  });

  it('collects workspaces without metadata into a trailing unlinked bucket', () => {
    const groups = groupWorkspacesByIssue(
      [ws('a'), ws('b'), ws('c')],
      new Map<string, WorkspaceIssueMeta | null>([
        [key('a'), meta('I1', 'To do')],
        [key('b'), null],
        // 'c' is missing entirely → also unlinked
      ])
    );
    expect(groups).toHaveLength(2);
    expect(groups[1].key).toBe(UNLINKED_GROUP_KEY);
    expect(groups[1].header).toBeNull();
    expect(groups[1].workspaces.map((w) => w.id)).toEqual(['b', 'c']);
  });

  it('omits the unlinked bucket when every workspace is linked', () => {
    const groups = groupWorkspacesByIssue(
      [ws('a')],
      new Map<string, WorkspaceIssueMeta | null>([
        [key('a'), meta('I1', 'To do')],
      ])
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('I1');
  });
});

describe('bucketIssueGroupsByStatus', () => {
  const labels = { unknown: 'Unknown', unlinked: 'No issue' };

  it('matches statuses case-insensitively and keeps configured empty sections', () => {
    const groups = groupWorkspacesByIssue(
      [ws('a'), ws('b')],
      new Map<string, WorkspaceIssueMeta | null>([
        [key('a'), meta('I1', 'to do')], // lowercase → matches "To do"
        [key('b'), meta('I2', 'Done')],
      ])
    );
    const sections = bucketIssueGroupsByStatus(
      groups,
      ['To do', 'In progress', 'Done'],
      labels
    );
    expect(sections.map((s) => s.label)).toEqual([
      'To do',
      'In progress',
      'Done',
    ]);
    expect(sections[0].groups.map((g) => g.key)).toEqual(['I1']);
    expect(sections[1].groups).toEqual([]); // empty but still present
    expect(sections[2].groups.map((g) => g.key)).toEqual(['I2']);
  });

  it('routes non-matching statuses to a trailing unknown section, only when non-empty', () => {
    const groups = groupWorkspacesByIssue(
      [ws('a')],
      new Map<string, WorkspaceIssueMeta | null>([
        [key('a'), meta('I1', 'Archived')],
      ])
    );
    const sections = bucketIssueGroupsByStatus(groups, ['To do'], labels);
    expect(sections.map((s) => s.key)).toEqual([
      'status-0-to do',
      UNKNOWN_STATUS_KEY,
    ]);
    expect(sections[1].groups.map((g) => g.key)).toEqual(['I1']);
  });

  it('puts the unlinked bucket into its own trailing section', () => {
    const groups = groupWorkspacesByIssue(
      [ws('a'), ws('b')],
      new Map<string, WorkspaceIssueMeta | null>([
        [key('a'), meta('I1', 'To do')],
      ])
    );
    const sections = bucketIssueGroupsByStatus(groups, ['To do'], labels);
    const unlinked = sections.find((s) => s.key === UNLINKED_GROUP_KEY);
    expect(unlinked).toBeDefined();
    expect(unlinked!.groups[0].workspaces.map((w) => w.id)).toEqual(['b']);
  });

  it('ignores blank and case-insensitive duplicate status names', () => {
    const sections = bucketIssueGroupsByStatus(
      [],
      ['To do', '  ', 'TO DO'],
      labels
    );
    expect(sections.map((s) => s.label)).toEqual(['To do']);
  });
});
