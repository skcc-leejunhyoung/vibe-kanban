import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureTestAuthRuntime,
  electricSessions,
  emitChange,
  emitSnapshot,
  installDomlessReact,
  lastSessionFor,
  resetElectricSessions,
} from '@/shared/lib/electric/electricTestKit';
import {
  useProjectContext,
  type ProjectContextValue,
} from '@/shared/hooks/useProjectContext';
import { ProjectProvider } from './ProjectProvider';

vi.mock('@tanstack/electric-db-collection', async () => {
  const kit = await import('@/shared/lib/electric/electricTestKit');
  return { electricCollectionOptions: kit.fakeElectricCollectionOptions };
});
vi.mock('@/shared/lib/remoteApi', () => ({
  makeRequest: vi.fn(),
  getRemoteApiUrl: () => 'http://api.test',
}));

let dom: ReturnType<typeof installDomlessReact>;
let projectCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  resetElectricSessions();
  configureTestAuthRuntime();
  dom = installDomlessReact();
});

afterEach(async () => {
  await dom.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function seedRows(
  projectId: string
): Record<string, Record<string, unknown>[]> {
  const p = projectId;
  return {
    issues: [
      { id: 'i1', project_id: p, title: 'one', status_id: 's1', sort_order: 1 },
      { id: 'i2', project_id: p, title: 'two', status_id: 's1', sort_order: 2 },
    ],
    project_statuses: [
      { id: 's1', project_id: p, name: 'Todo', sort_order: 1, hidden: false },
    ],
    tags: [{ id: 't1', project_id: p, name: 'bug', color: '#f00' }],
    issue_tags: [{ id: 'it1', project_id: p, issue_id: 'i1', tag_id: 't1' }],
    project_milestones: [{ id: 'm1', project_id: p, name: 'v1' }],
    issue_milestones: [
      { id: 'im1', project_id: p, issue_id: 'i1', milestone_id: 'm1' },
    ],
    issue_assignees: [
      { id: 'ia1', project_id: p, issue_id: 'i1', user_id: 'u1' },
    ],
    issue_relationships: [
      {
        id: 'r1',
        project_id: p,
        issue_id: 'i1',
        related_issue_id: 'i2',
        relationship_type: 'blocking',
      },
    ],
    pull_requests: [
      { id: 'pr1', project_id: p, issue_id: 'i1', workspace_id: null },
    ],
    pull_request_issues: [
      { id: 'pri1', project_id: p, pull_request_id: 'pr1', issue_id: 'i1' },
    ],
    github_issue_links: [
      { id: 'g1', project_id: p, issue_id: 'i1', number: 7, url: 'u' },
    ],
    workspaces: [{ id: 'w1', project_id: p, issue_id: 'i1' }],
  };
}

async function renderProvider() {
  const projectId = `p${++projectCounter}`;
  const values: ProjectContextValue[] = [];
  let bump: () => void = () => {};
  function Probe() {
    values.push(useProjectContext());
    return null;
  }
  // The provider's own parent re-renders (e.g. on org context changes), which
  // is what must not fan out to every consumer when no shape data changed.
  function Host() {
    const [, setTick] = useState(0);
    bump = () => setTick((t) => t + 1);
    return (
      <ProjectProvider projectId={projectId}>
        <Probe />
      </ProjectProvider>
    );
  }
  await dom.render(<Host />);

  const rows = seedRows(projectId);
  await act(() => {
    for (const session of electricSessions) {
      // Collection ids are `<table>-<project id>` (legacy: `…-mut` suffix).
      const base = session.id.replace(/-mut$/, '');
      const table = base.slice(0, base.lastIndexOf('-'));
      emitSnapshot(session, rows[table] ?? []);
    }
  });

  return {
    projectId,
    latest: () => values[values.length - 1],
    rerenderParent: () => act(() => bump()),
    session: (table: string) => lastSessionFor(`${table}-${projectId}`),
  };
}

describe('ProjectProvider context stability', () => {
  it('keeps the context value when the parent re-renders without data changes', async () => {
    const provider = await renderProvider();
    const settled = provider.latest();
    expect(settled.isLoading).toBe(false);
    expect(settled.issues).toHaveLength(2);

    await provider.rerenderParent();

    expect(provider.latest()).toBe(settled);
  });

  it('keeps per-issue lookups referentially stable across an unrelated shape update', async () => {
    const provider = await renderProvider();
    const before = provider.latest();
    const tags = before.getTagObjectsForIssue('i1');
    const issueTags = before.getTagsForIssue('i1');
    const assignees = before.getAssigneesForIssue('i1');
    const prs = before.getPullRequestsForIssue('i1');
    const relationships = before.getRelationshipsForIssue('i1');
    const milestone = before.getMilestoneForIssue('i1');
    const link = before.getGithubIssueLinkForIssue('i1');
    const byStatus = before.getIssuesForStatus('s1');
    expect(tags.map((t) => t.id)).toEqual(['t1']);
    expect(prs.map((pr) => pr.id)).toEqual(['pr1']);
    expect(relationships.map((r) => r.id)).toEqual(['r1']);
    expect(milestone?.id).toBe('m1');
    expect(link?.id).toBe('g1');

    // Lookups are answered from maps built once per data change, so repeated
    // calls hand back the same arrays instead of fresh filter() results.
    expect(before.getTagObjectsForIssue('i1')).toBe(tags);

    // A workspace insert for another issue leaves every i1 lookup untouched.
    await act(() =>
      emitChange(provider.session('workspaces'), 'insert', {
        id: 'w2',
        project_id: provider.projectId,
        issue_id: 'i2',
      })
    );
    const after = provider.latest();
    expect(after).not.toBe(before);
    expect(after.getWorkspacesForIssue('i2')).toHaveLength(1);
    expect(after.getTagObjectsForIssue('i1')).toBe(tags);
    expect(after.getTagsForIssue('i1')).toBe(issueTags);
    expect(after.getAssigneesForIssue('i1')).toBe(assignees);
    expect(after.getPullRequestsForIssue('i1')).toBe(prs);
    expect(after.getRelationshipsForIssue('i1')).toBe(relationships);
    expect(after.getMilestoneForIssue('i1')).toBe(milestone);
    expect(after.getGithubIssueLinkForIssue('i1')).toBe(link);
    expect(after.getIssuesForStatus('s1')).toBe(byStatus);
    expect(after.issuesById).toBe(before.issuesById);
  });

  it('keeps sibling issue lookups stable when the same shape changes for another issue', async () => {
    const provider = await renderProvider();
    const before = provider.latest();
    const tagsForI1 = before.getTagObjectsForIssue('i1');

    await act(() =>
      emitChange(provider.session('issue_tags'), 'insert', {
        id: 'it2',
        project_id: provider.projectId,
        issue_id: 'i2',
        tag_id: 't1',
      })
    );

    const after = provider.latest();
    expect(after.getTagObjectsForIssue('i2').map((t) => t.id)).toEqual(['t1']);
    expect(after.getTagObjectsForIssue('i1')).toBe(tagsForI1);
  });

  it('reflects related changes in the lookups', async () => {
    const provider = await renderProvider();
    const before = provider.latest();
    const prs = before.getPullRequestsForIssue('i1');

    await act(() =>
      emitChange(provider.session('pull_requests'), 'update', {
        id: 'pr1',
        project_id: provider.projectId,
        issue_id: 'i1',
        workspace_id: 'w1',
      })
    );

    const after = provider.latest();
    expect(after.getPullRequestsForIssue('i1')).not.toBe(prs);
    expect(after.getPullRequestsForIssue('i1')[0].workspace_id).toBe('w1');
  });
});
