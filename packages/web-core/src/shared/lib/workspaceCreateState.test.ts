import { describe, expect, it, vi } from 'vitest';
import {
  buildLinkedIssueCreateState,
  buildLocalWorkspaceIdSet,
  defaultWorkspaceDraftId,
  resolveGithubLinkedBranchSource,
  toDraftWorkspaceData,
} from './workspaceCreateState';

// The module pulls in the API + local-storage scratch helpers at import time;
// none are exercised by these pure-function tests.
vi.mock('@/shared/lib/api', () => ({
  scratchApi: { update: vi.fn() },
}));
vi.mock('@/shared/hooks/useLocalStorageScratch', () => ({
  localStorageScratchUpdate: vi.fn(),
}));

const link = (over: Partial<Record<string, unknown>> = {}) => ({
  issue_id: 'issue-1',
  repository: 'skcc-ai/c2',
  github_node_id: 'I_node_1',
  ...over,
});

describe('buildLocalWorkspaceIdSet', () => {
  it('offers no candidates until the archive is in', () => {
    const active = [{ id: 'active' }];
    const archived = [{ id: 'archived' }];
    expect(buildLocalWorkspaceIdSet(active, [], true)).toEqual(new Set());
    expect(buildLocalWorkspaceIdSet(active, archived, false)).toEqual(
      new Set(['active', 'archived'])
    );
  });

  it('offers only the workspaces of the host the new one is created on', () => {
    const active = [
      { id: 'here', hostId: null },
      { id: 'on-b', hostId: 'host-b' },
    ];
    const archived = [{ id: 'old-on-b', hostId: 'host-b' }];
    expect(buildLocalWorkspaceIdSet(active, archived, false, 'host-b')).toEqual(
      new Set(['on-b', 'old-on-b'])
    );
    expect(buildLocalWorkspaceIdSet(active, archived, false, null)).toEqual(
      new Set(['here'])
    );
    // No host named: every row stays a candidate, as before.
    expect(buildLocalWorkspaceIdSet(active, archived, false).size).toBe(3);
  });
});

describe('defaultWorkspaceDraftId', () => {
  it('gives each host its own draft on the remote web', () => {
    // There the draft lives in one browser store shared by every host.
    const a = defaultWorkspaceDraftId('remote', 'host-a');
    const b = defaultWorkspaceDraftId('remote', 'host-b');
    expect(a).not.toBe(b);
    expect(a.endsWith('@host-a')).toBe(true);
  });

  it('keeps the plain id on the local web, where each host stores its own', () => {
    expect(defaultWorkspaceDraftId('local', 'host-a')).toBe(
      defaultWorkspaceDraftId('local', null)
    );
  });
});

describe('resolveGithubLinkedBranchSource', () => {
  it('returns node id + repo for the matching issue link', () => {
    expect(resolveGithubLinkedBranchSource([link()], 'issue-1')).toEqual({
      githubNodeId: 'I_node_1',
      repository: 'skcc-ai/c2',
    });
  });

  it('returns null when the link belongs to another issue', () => {
    expect(resolveGithubLinkedBranchSource([link()], 'issue-2')).toBeNull();
  });

  it('skips links that have no node id (cannot be linked)', () => {
    expect(
      resolveGithubLinkedBranchSource(
        [link({ github_node_id: null })],
        'issue-1'
      )
    ).toBeNull();
  });

  it('tolerates a missing/empty link list', () => {
    expect(resolveGithubLinkedBranchSource(undefined, 'issue-1')).toBeNull();
    expect(resolveGithubLinkedBranchSource([], 'issue-1')).toBeNull();
  });
});

describe('buildLinkedIssueCreateState', () => {
  const issue = { id: 'issue-1', simple_id: '42', title: 'Fix it' };

  it('carries the GitHub link when supplied', () => {
    const state = buildLinkedIssueCreateState(issue, 'project-1', {
      githubNodeId: 'I_node_1',
      repository: 'skcc-ai/c2',
    });
    expect(state).toMatchObject({
      issueId: 'issue-1',
      remoteProjectId: 'project-1',
      githubNodeId: 'I_node_1',
      githubRepository: 'skcc-ai/c2',
    });
  });

  it('leaves GitHub fields null without a link', () => {
    const state = buildLinkedIssueCreateState(issue, 'project-1');
    expect(state?.githubNodeId).toBeNull();
    expect(state?.githubRepository).toBeNull();
  });
});

describe('toDraftWorkspaceData', () => {
  it('persists the GitHub link on the linked-issue row (drives the target toggle)', () => {
    const draft = toDraftWorkspaceData({
      initialPrompt: 'do the thing',
      linkedIssue: {
        issueId: 'issue-1',
        remoteProjectId: 'project-1',
        githubNodeId: 'I_node_1',
        githubRepository: 'skcc-ai/c2',
      },
    });
    // Working branch is unaffected — the linked branch is a target, not the
    // working branch.
    expect(draft.working_branch).toBeNull();
    expect(draft.linked_issue).toMatchObject({
      github_node_id: 'I_node_1',
      github_repository: 'skcc-ai/c2',
    });
  });

  it('leaves GitHub link null without a mapped GitHub issue', () => {
    const draft = toDraftWorkspaceData({
      initialPrompt: 'do the thing',
      linkedIssue: {
        issueId: 'issue-1',
        remoteProjectId: 'project-1',
      },
    });
    expect(draft.working_branch).toBeNull();
    expect(draft.linked_issue).toMatchObject({
      github_node_id: null,
      github_repository: null,
    });
  });
});
