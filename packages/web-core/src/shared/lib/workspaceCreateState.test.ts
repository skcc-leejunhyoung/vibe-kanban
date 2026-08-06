import { describe, expect, it, vi } from 'vitest';
import {
  buildLinkedIssueCreateState,
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
