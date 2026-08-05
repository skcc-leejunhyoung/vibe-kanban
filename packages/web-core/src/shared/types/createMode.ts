import type { ExecutorConfig } from 'shared/types';

export interface LinkedIssue {
  issueId: string;
  simpleId?: string;
  title?: string;
  remoteProjectId: string;
  /**
   * When the issue is mapped to a GitHub issue: the issue's GraphQL node id and
   * its `owner/repo`. Present only for GitHub-linked issues; enables the
   * "GitHub linked branch" working-branch mode in create mode.
   */
  githubNodeId?: string | null;
  githubRepository?: string | null;
}

export interface CreateModeInitialState {
  initialPrompt?: string | null;
  preferredRepos?: Array<{
    repo_id: string;
    target_branch: string | null;
  }> | null;
  project_id?: string | null;
  linkedIssue?: LinkedIssue | null;
  executorConfig?: ExecutorConfig | null;
}
