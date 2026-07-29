// Import all necessary types from shared types

import {
  ApprovalStatus,
  ApiResponse,
  Config,
  CreateFollowUpAttempt,
  CreateHandoffAttempt,
  ResetProcessRequest,
  EditorType,
  CreatePrApiRequest,
  GeneratePrDescriptionRequest,
  GeneratePrDescriptionResponse,
  PrDescriptionGenerationStatus,
  StartPrDescriptionGenerationResponse,
  PrDraft,
  CreateTag,
  DirectoryListResponse,
  DirectoryEntry,
  ExecutionProcess,
  ExecutionProcessRepoState,
  GitBranch,
  Repo,
  RepoWithTargetBranch,
  UpdateRepo,
  SearchMode,
  SearchResult,
  Tag,
  TagSearchParams,
  UpdateTag,
  UserSystemInfo,
  HostAppearance,
  McpServerQuery,
  UpdateMcpServersBody,
  GetMcpServerResponse,
  AttachmentResponse,
  GitOperationError,
  ApprovalResponse,
  RebaseWorkspaceRequest,
  ChangeTargetBranchRequest,
  ChangeTargetBranchResponse,
  RenameBranchRequest,
  RenameBranchResponse,
  CheckEditorAvailabilityResponse,
  AvailabilityInfo,
  BaseCodingAgent,
  ExecutorConfig,
  ExecutorProfile,
  DraftFollowUpData,
  AgentPresetOptionsQuery,
  RunAgentSetupRequest,
  RunAgentSetupResponse,
  GhCliSetupError,
  RunScriptError,
  StatusResponse,
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  ListOrganizationsResponse,
  OrganizationMemberWithProfile,
  ListMembersResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  RevokeInvitationRequest,
  UpdateMemberRoleRequest,
  UpdateMemberRoleResponse,
  Invitation,
  ListInvitationsResponse,
  OpenEditorResponse,
  OpenEditorRequest,
  PrError,
  Scratch,
  ScratchType,
  CreateScratch,
  UpdateScratch,
  PushError,
  TokenResponse,
  CurrentUserResponse,
  QueueStatus,
  PrCommentsResponse,
  MergeWorkspaceRequest,
  CommitWorkspaceRequest,
  CommitWorkspaceResponse,
  PushWorkspaceRequest,
  FetchTargetBranchRequest,
  PushTargetBranchRequest,
  PullTargetBranchRequest,
  TargetBranchRemoteStatus,
  PullWorkspaceRequest,
  PullWorkspaceResponse,
  UpdateFromBaseRequest,
  UpdateTargetBranchFromBaseRequest,
  RepoBranchStatus,
  WorkspaceCommit,
  Diff,
  AbortConflictsRequest,
  ContinueRebaseRequest,
  Session,
  Workspace,
  StartReviewRequest,
  ReviewError,
  GitRemote,
  ListPrsError,
  PullRequestDetail,
  LinkPrToIssueRequest,
  AttachExistingPrRequest,
  AttachPrResponse,
  CreateWorkspaceFromPrBody,
  CreateWorkspaceFromPrResponse,
  CreateFromPrError,
  CreateAndStartWorkspaceRequest,
  CreateAndStartWorkspaceResponse,
  CreateQuickChatRequest,
  GenerateSpecRequest,
  GenerateSpecResponse,
  CreateWorkspaceWithoutStartingRequest,
  CreateWorkspaceWithoutStartingResponse,
  RelayPairedClient,
  ListRelayPairedClientsResponse,
  RemoveRelayPairedClientResponse,
  PairRelayHostRequest,
  PairRelayHostResponse,
  RelayPairedHost,
  ListRelayPairedHostsResponse,
  SelfRelayHostResponse,
  RemoveRelayPairedHostResponse,
  OpenRemoteWorkspaceInEditorRequest,
  OpenRemoteEditorResponse,
  ProfileResponse,
} from 'shared/types';
import type {
  Project as RemoteProject,
  UpdateUserNotificationPreferenceRequest,
  UserNotificationPreference,
} from 'shared/remote-types';
import type { WorkspaceWithSession } from '@/shared/types/attempt';
import { createWorkspaceWithSession } from '@/shared/types/attempt';
import { resolveHostRequestScope } from '@/shared/lib/hostRequestScope';
import { makeRequest as makeRemoteRequest } from '@/shared/lib/remoteApi';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';

export type {
  UpdateUserNotificationPreferenceRequest,
  UserNotificationPreference,
} from 'shared/remote-types';

export class ApiError<E = unknown> extends Error {
  public status?: number;
  public error_data?: E;

  constructor(
    message: string,
    public statusCode?: number,
    public response?: Response,
    error_data?: E
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = statusCode;
    this.error_data = error_data;
  }
}

const makeRequest = async (url: string, options: RequestInit = {}) => {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return makeLocalApiRequest(url, {
    ...options,
    headers,
  });
};

const makeScopedRequest = async (
  url: string,
  hostId: string | null,
  options: RequestInit = {}
) => {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return makeLocalApiRequest(url, {
    ...options,
    headers,
    hostScope: 'explicit',
    hostId,
    relayHostId: hostId,
  });
};

const makeHostAwareRequest = async (
  url: string,
  hostId: string | null | undefined,
  options: RequestInit = {}
) => {
  const scope = resolveHostRequestScope(hostId);

  if (scope.kind === 'current') {
    return makeRequest(url, options);
  }

  return makeScopedRequest(
    url,
    scope.kind === 'host' ? scope.hostId : null,
    options
  );
};

export type Ok<T> = { success: true; data: T };
export type Err<E> = { success: false; error: E | undefined; message?: string };

// Auto-resume (usage-based) status for a session
export interface SessionAutoResumeStatus {
  enabled: boolean;
  /** RFC3339 timestamp when a resume is scheduled, or null if none pending */
  pending_resume_at: string | null;
}

// Result type for endpoints that need typed errors
export type Result<T, E> = Ok<T> | Err<E>;

type ListRemoteProjectsResponse = {
  projects: RemoteProject[];
};

// Special handler for Result-returning endpoints
const handleApiResponseAsResult = async <T, E>(
  response: Response
): Promise<Result<T, E>> => {
  if (!response.ok) {
    // HTTP error - no structured error data
    let errorMessage = `Request failed with status ${response.status}`;

    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {
      errorMessage = response.statusText || errorMessage;
    }

    return {
      success: false,
      error: undefined,
      message: errorMessage,
    };
  }

  const result: ApiResponse<T, E> = await response.json();

  if (!result.success) {
    return {
      success: false,
      error: result.error_data || undefined,
      message: result.message || undefined,
    };
  }

  return { success: true, data: result.data as T };
};

export const handleApiResponse = async <T, E = T>(
  response: Response
): Promise<T> => {
  if (!response.ok) {
    let errorMessage = `Request failed with status ${response.status}`;

    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {
      // Fallback to status text if JSON parsing fails
      errorMessage = response.statusText || errorMessage;
    }

    console.error('[API Error]', {
      message: errorMessage,
      status: response.status,
      response,
      endpoint: response.url,
      timestamp: new Date().toISOString(),
    });
    throw new ApiError<E>(errorMessage, response.status, response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const result: ApiResponse<T, E> = await response.json();

  if (!result.success) {
    // Check for error_data first (structured errors), then fall back to message
    if (result.error_data) {
      console.error('[API Error with data]', {
        error_data: result.error_data,
        message: result.message,
        status: response.status,
        response,
        endpoint: response.url,
        timestamp: new Date().toISOString(),
      });
      // Throw a properly typed error with the error data
      throw new ApiError<E>(
        result.message || 'API request failed',
        response.status,
        response,
        result.error_data
      );
    }

    console.error('[API Error]', {
      message: result.message || 'API request failed',
      status: response.status,
      response,
      endpoint: response.url,
      timestamp: new Date().toISOString(),
    });
    throw new ApiError<E>(
      result.message || 'API request failed',
      response.status,
      response
    );
  }

  return result.data as T;
};

// Sessions API
export const sessionsApi = {
  getByWorkspace: async (
    workspaceId: string,
    hostId?: string | null
  ): Promise<Session[]> => {
    const response = await makeHostAwareRequest(
      `/api/sessions?workspace_id=${workspaceId}`,
      hostId
    );
    return handleApiResponse<Session[]>(response);
  },

  getById: async (sessionId: string): Promise<Session> => {
    const response = await makeRequest(`/api/sessions/${sessionId}`);
    return handleApiResponse<Session>(response);
  },

  create: async (
    data: {
      workspace_id: string;
      executor?: string;
      variant?: string | null;
      name?: string;
    },
    hostId?: string | null
  ): Promise<Session> => {
    const response = await makeHostAwareRequest('/api/sessions', hostId, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Session>(response);
  },

  followUp: async (
    sessionId: string,
    data: CreateFollowUpAttempt
  ): Promise<ExecutionProcess> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/follow-up`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<ExecutionProcess>(response);
  },

  handoff: async (
    sessionId: string,
    data: CreateHandoffAttempt
  ): Promise<ExecutionProcess> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/handoff`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<ExecutionProcess>(response);
  },

  startReview: async (
    sessionId: string,
    data: StartReviewRequest,
    hostId?: string | null
  ): Promise<ExecutionProcess> => {
    const response = await makeHostAwareRequest(
      `/api/sessions/${sessionId}/review`,
      hostId,
      { method: 'POST', body: JSON.stringify(data) }
    );
    return handleApiResponse<ExecutionProcess, ReviewError>(response);
  },

  /** Manually start an automated `vibe` review session for the workspace, as if
   * the coding agent had reported `VIBE_RESULT: done`. Returns the new session. */
  vibeReview: async (
    sessionId: string,
    hostId?: string | null
  ): Promise<Session> => {
    const response = await makeHostAwareRequest(
      `/api/sessions/${sessionId}/vibe-review`,
      hostId,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<Session, ReviewError>(response);
  },

  reset: async (
    sessionId: string,
    data: ResetProcessRequest
  ): Promise<void> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/reset`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<void>(response);
  },

  runSetupScript: async (
    sessionId: string,
    hostId?: string | null
  ): Promise<Result<ExecutionProcess, RunScriptError>> => {
    const response = await makeHostAwareRequest(
      `/api/sessions/${sessionId}/setup`,
      hostId,
      {
        method: 'POST',
      }
    );
    return handleApiResponseAsResult<ExecutionProcess, RunScriptError>(
      response
    );
  },

  update: async (
    sessionId: string,
    data: { name?: string },
    hostId?: string | null
  ): Promise<Session> => {
    const response = await makeHostAwareRequest(
      `/api/sessions/${sessionId}`,
      hostId,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<Session>(response);
  },

  delete: async (sessionId: string, hostId?: string | null): Promise<void> => {
    const response = await makeHostAwareRequest(
      `/api/sessions/${sessionId}`,
      hostId,
      {
        method: 'DELETE',
      }
    );
    return handleApiResponse<void>(response);
  },

  getAutoResume: async (
    sessionId: string
  ): Promise<SessionAutoResumeStatus> => {
    const response = await makeRequest(
      `/api/sessions/${sessionId}/auto-resume`
    );
    return handleApiResponse<SessionAutoResumeStatus>(response);
  },

  setAutoResume: async (
    sessionId: string,
    enabled: boolean
  ): Promise<SessionAutoResumeStatus> => {
    const response = await makeRequest(
      `/api/sessions/${sessionId}/auto-resume`,
      {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }
    );
    return handleApiResponse<SessionAutoResumeStatus>(response);
  },
};

export const specApi = {
  /**
   * Expand a rough brief into a development-ready technical task by running a
   * coding agent in a throwaway multi-repo workspace. Long-running (~20-60s);
   * the client timeout (180s) strictly exceeds the 120s server timeout so the
   * server's own timeout error surfaces rather than a client abort.
   */
  generate: async (
    data: GenerateSpecRequest,
    signal?: AbortSignal
  ): Promise<GenerateSpecResponse> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }
    try {
      const response = await makeRequest(`/api/spec/generate`, {
        method: 'POST',
        body: JSON.stringify(data),
        signal: controller.signal,
      });
      return handleApiResponse<GenerateSpecResponse>(response);
    } finally {
      clearTimeout(timeout);
    }
  },
};

// Workspace APIs
export const workspacesApi = {
  createOnly: async (
    data: CreateWorkspaceWithoutStartingRequest
  ): Promise<CreateWorkspaceWithoutStartingResponse> => {
    const response = await makeRequest(`/api/workspaces/create`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<CreateWorkspaceWithoutStartingResponse>(response);
  },

  createAndStart: async (
    data: CreateAndStartWorkspaceRequest
  ): Promise<CreateAndStartWorkspaceResponse> => {
    const response = await makeRequest(`/api/workspaces/start`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<CreateAndStartWorkspaceResponse>(response);
  },

  /**
   * "Quick chat": run an agent directly in a repo's existing checkout (in-place,
   * no `vk/` worktree, no new branch). Returns the same shape as createAndStart.
   */
  quickChat: async (
    data: CreateQuickChatRequest,
    hostId?: string | null
  ): Promise<CreateAndStartWorkspaceResponse> => {
    const response = await makeHostAwareRequest(
      `/api/workspaces/quick-chat`,
      hostId,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<CreateAndStartWorkspaceResponse>(response);
  },

  getAll: async (taskId: string): Promise<Workspace[]> => {
    const response = await makeRequest(`/api/workspaces?task_id=${taskId}`);
    return handleApiResponse<Workspace[]>(response);
  },

  /** Get all workspaces across all tasks (newest first) */
  getAllWorkspaces: async (hostId?: string | null): Promise<Workspace[]> => {
    const response = await makeHostAwareRequest('/api/workspaces', hostId);
    return handleApiResponse<Workspace[]>(response);
  },

  get: async (
    workspaceId: string,
    hostId?: string | null
  ): Promise<Workspace> => {
    const response = await makeHostAwareRequest(
      `/api/workspaces/${workspaceId}`,
      hostId
    );
    return handleApiResponse<Workspace>(response);
  },

  /** Resolve the project id this workspace belongs to (null when unlinked) */
  getProjectId: async (workspaceId: string): Promise<string | null> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/project`
    );
    return handleApiResponse<string | null>(response);
  },

  update: async (
    workspaceId: string,
    data: { archived?: boolean; pinned?: boolean; name?: string },
    hostId?: string | null
  ): Promise<Workspace> => {
    const response = await makeHostAwareRequest(
      `/api/workspaces/${workspaceId}`,
      hostId,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<Workspace>(response);
  },

  /** Get workspace with latest session */
  getWithSession: async (
    workspaceId: string,
    hostId?: string | null
  ): Promise<WorkspaceWithSession> => {
    const [workspace, sessions] = await Promise.all([
      workspacesApi.get(workspaceId, hostId),
      sessionsApi.getByWorkspace(workspaceId, hostId),
    ]);
    return createWorkspaceWithSession(workspace, sessions[0]);
  },

  stop: async (workspaceId: string): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/execution/stop`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<void>(response);
  },

  delete: async (
    workspaceId: string,
    deleteBranches?: boolean,
    hostId?: string | null
  ): Promise<void> => {
    const params = new URLSearchParams();
    if (deleteBranches) {
      params.set('delete_branches', 'true');
    }
    const queryString = params.toString();
    const url = `/api/workspaces/${workspaceId}${queryString ? `?${queryString}` : ''}`;
    const response = await makeHostAwareRequest(url, hostId, {
      method: 'DELETE',
    });
    return handleApiResponse<void>(response);
  },

  linkToIssue: async (
    workspaceId: string,
    projectId: string,
    issueId: string,
    hostId?: string | null
  ): Promise<void> => {
    const response = await makeHostAwareRequest(
      `/api/workspaces/${workspaceId}/links`,
      hostId,
      {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, issue_id: issueId }),
      }
    );
    return handleApiResponse<void>(response);
  },

  unlinkFromIssue: async (
    workspaceId: string,
    hostId?: string | null
  ): Promise<void> => {
    const response = await makeHostAwareRequest(
      `/api/workspaces/${workspaceId}/links`,
      hostId,
      { method: 'DELETE' }
    );
    return handleApiResponse<void>(response);
  },

  runAgentSetup: async (
    workspaceId: string,
    data: RunAgentSetupRequest
  ): Promise<RunAgentSetupResponse> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/integration/agent/setup`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<RunAgentSetupResponse>(response);
  },

  openEditor: async (
    workspaceId: string,
    data: OpenEditorRequest
  ): Promise<OpenEditorResponse> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/integration/editor/open`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<OpenEditorResponse>(response);
  },

  getEditorPath: async (
    workspaceId: string
  ): Promise<{ workspace_path: string }> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/integration/editor/path`
    );
    return handleApiResponse<{ workspace_path: string }>(response);
  },

  getBranchStatus: async (
    workspaceId: string,
    hostId?: string | null
  ): Promise<RepoBranchStatus[]> => {
    const response = await makeHostAwareRequest(
      `/api/workspaces/${workspaceId}/git/status`,
      hostId
    );
    return handleApiResponse<RepoBranchStatus[]>(response);
  },

  getCommits: async (
    workspaceId: string,
    hostId?: string | null
  ): Promise<WorkspaceCommit[]> => {
    const response = await makeHostAwareRequest(
      `/api/workspaces/${workspaceId}/git/commits`,
      hostId
    );
    return handleApiResponse<WorkspaceCommit[]>(response);
  },

  getCommitDiff: async (
    workspaceId: string,
    repoId: string,
    sha: string,
    hostId?: string | null
  ): Promise<Diff[]> => {
    const params = new URLSearchParams({ repo_id: repoId, sha });
    const response = await makeHostAwareRequest(
      `/api/workspaces/${workspaceId}/git/commit-diff?${params.toString()}`,
      hostId
    );
    return handleApiResponse<Diff[]>(response);
  },

  getRepos: async (
    workspaceId: string,
    hostId?: string | null
  ): Promise<RepoWithTargetBranch[]> => {
    const response = await makeHostAwareRequest(
      `/api/workspaces/${workspaceId}/repos`,
      hostId
    );
    return handleApiResponse<RepoWithTargetBranch[]>(response);
  },

  getFirstUserMessage: async (
    workspaceId: string,
    hostId?: string | null
  ): Promise<string | null> => {
    const response = await makeHostAwareRequest(
      `/api/workspaces/${workspaceId}/messages/first`,
      hostId
    );
    return handleApiResponse<string | null>(response);
  },

  merge: async (
    workspaceId: string,
    data: MergeWorkspaceRequest
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/merge`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<void>(response);
  },

  commit: async (
    workspaceId: string,
    data: CommitWorkspaceRequest
  ): Promise<CommitWorkspaceResponse> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/commit`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<CommitWorkspaceResponse>(response);
  },

  push: async (
    workspaceId: string,
    data: PushWorkspaceRequest
  ): Promise<Result<void, PushError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/push`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponseAsResult<void, PushError>(response);
  },

  forcePush: async (
    workspaceId: string,
    data: PushWorkspaceRequest
  ): Promise<Result<void, PushError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/push/force`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponseAsResult<void, PushError>(response);
  },

  /**
   * Safely resolve a diverged push: fetch + merge the branch's own remote into
   * the local branch, then push. The non-destructive alternative to a force
   * push. Merge conflicts come back as a `GitOperationError` so the existing
   * conflict UI can take over.
   */
  pullAndPush: async (
    workspaceId: string,
    data: PushWorkspaceRequest
  ): Promise<Result<void, GitOperationError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/pull-and-push`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponseAsResult<void, GitOperationError>(response);
  },

  /**
   * Target (base) branch counterpart of `pullAndPush`: fetch + merge the target
   * branch's own remote into it, then push. Non-destructive resolution for a
   * diverged target-branch push.
   */
  pullAndPushTargetBranch: async (
    workspaceId: string,
    repoId: string
  ): Promise<Result<void, GitOperationError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/target-branch/pull-and-push`,
      {
        method: 'POST',
        body: JSON.stringify({ repo_id: repoId }),
      }
    );
    return handleApiResponseAsResult<void, GitOperationError>(response);
  },

  rebase: async (
    workspaceId: string,
    data: RebaseWorkspaceRequest
  ): Promise<Result<void, GitOperationError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/rebase`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponseAsResult<void, GitOperationError>(response);
  },

  /** Fast-forward the work branch to its own remote (`git pull --ff-only`). */
  pull: async (
    workspaceId: string,
    data: PullWorkspaceRequest
  ): Promise<PullWorkspaceResponse> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/pull`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<PullWorkspaceResponse>(response);
  },

  /** Bring the target (base) branch into the work branch via merge or rebase. */
  updateFromBase: async (
    workspaceId: string,
    data: UpdateFromBaseRequest
  ): Promise<Result<void, GitOperationError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/update-from-base`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponseAsResult<void, GitOperationError>(response);
  },

  /** Merge a selected base branch into the workspace's target branch. */
  updateTargetBranchFromBase: async (
    workspaceId: string,
    data: UpdateTargetBranchFromBaseRequest
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/target-branch/update-from-base`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<void>(response);
  },

  change_target_branch: async (
    workspaceId: string,
    data: ChangeTargetBranchRequest
  ): Promise<ChangeTargetBranchResponse> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/target-branch`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<ChangeTargetBranchResponse>(response);
  },

  /** Ahead/behind of the workspace's target branch vs the repo's origin. */
  getTargetBranchRemoteStatus: async (
    workspaceId: string,
    repoId: string
  ): Promise<TargetBranchRemoteStatus> => {
    const params = new URLSearchParams({ repo_id: repoId });
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/target-branch/remote-status?${params.toString()}`,
      { cache: 'no-store' }
    );
    return handleApiResponse<TargetBranchRemoteStatus>(response);
  },

  /** Fetch the repo's origin, refreshing the target branch's tracking ref. */
  fetchTargetBranch: async (
    workspaceId: string,
    repoId: string
  ): Promise<TargetBranchRemoteStatus> => {
    const payload: FetchTargetBranchRequest = { repo_id: repoId };
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/target-branch/fetch`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    return handleApiResponse<TargetBranchRemoteStatus>(response);
  },

  /** Push the workspace's target (base) branch to the repo's origin. */
  pushTargetBranch: async (
    workspaceId: string,
    repoId: string,
    force = false
  ): Promise<Result<TargetBranchRemoteStatus, PushError>> => {
    const payload: PushTargetBranchRequest = { repo_id: repoId, force };
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/target-branch/push`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    return handleApiResponseAsResult<TargetBranchRemoteStatus, PushError>(
      response
    );
  },

  /** Fetch, then fast-forward the target (base) branch from origin (ff-only). */
  pullTargetBranch: async (
    workspaceId: string,
    repoId: string
  ): Promise<TargetBranchRemoteStatus> => {
    const payload: PullTargetBranchRequest = { repo_id: repoId };
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/target-branch/pull`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    return handleApiResponse<TargetBranchRemoteStatus>(response);
  },

  renameBranch: async (
    workspaceId: string,
    newBranchName: string
  ): Promise<RenameBranchResponse> => {
    const payload: RenameBranchRequest = {
      new_branch_name: newBranchName,
    };
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/branch`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      }
    );
    return handleApiResponse<RenameBranchResponse>(response);
  },

  abortConflicts: async (
    workspaceId: string,
    data: AbortConflictsRequest
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/conflicts/abort`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<void>(response);
  },

  continueRebase: async (
    workspaceId: string,
    data: ContinueRebaseRequest
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/git/rebase/continue`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<void>(response);
  },

  createPR: async (
    workspaceId: string,
    data: CreatePrApiRequest,
    signal?: AbortSignal
  ): Promise<Result<string, PrError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests`,
      {
        method: 'POST',
        body: JSON.stringify(data),
        signal,
      }
    );
    return handleApiResponseAsResult<string, PrError>(response);
  },

  /**
   * Generate a PR title + description through a short start request followed by
   * polling. Each request stays below the remote relay timeout while the coding
   * agent continues in the local server background.
   */
  generatePrDescription: async (
    workspaceId: string,
    data: GeneratePrDescriptionRequest,
    signal?: AbortSignal
  ): Promise<GeneratePrDescriptionResponse> => {
    const startResponse = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/generate/start`,
      {
        method: 'POST',
        body: JSON.stringify(data),
        signal,
      }
    );
    const { job_id } =
      await handleApiResponse<StartPrDescriptionGenerationResponse>(
        startResponse
      );

    const statusUrl = `/api/workspaces/${workspaceId}/pull-requests/generate/status?job_id=${encodeURIComponent(job_id)}`;
    try {
      while (true) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            window.clearTimeout(timeout);
            reject(new DOMException('aborted', 'AbortError'));
          };
          const timeout = window.setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          }, 1_000);
          signal?.addEventListener('abort', onAbort, { once: true });
        });

        const statusResponse = await makeRequest(statusUrl, { signal });
        const status =
          await handleApiResponse<PrDescriptionGenerationStatus>(
            statusResponse
          );
        if (status.status === 'completed') {
          return { title: status.title, description: status.description };
        }
        if (status.status === 'failed') {
          throw new Error(status.error);
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        // The polling request is canceled locally; explicitly stop the detached
        // server job as a separate short relay request.
        void makeRequest(statusUrl, { method: 'DELETE' });
      }
      throw error;
    }
  },

  getPrDraft: async (
    workspaceId: string,
    repoId: string
  ): Promise<PrDraft | null> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/draft?repo_id=${encodeURIComponent(repoId)}`
    );
    return handleApiResponse<PrDraft | null>(response);
  },

  savePrDraft: async (workspaceId: string, draft: PrDraft): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/draft`,
      { method: 'PUT', body: JSON.stringify(draft) }
    );
    await handleApiResponse<void>(response);
  },

  deletePrDraft: async (workspaceId: string, repoId: string): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/draft?repo_id=${encodeURIComponent(repoId)}`,
      { method: 'DELETE' }
    );
    await handleApiResponse<void>(response);
  },

  /** Try to auto-attach a PR by matching the workspace branch */
  attachPr: async (
    workspaceId: string,
    data: AttachExistingPrRequest
  ): Promise<Result<AttachPrResponse, PrError>> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/attach`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponseAsResult<AttachPrResponse, PrError>(response);
  },

  startDevServer: async (workspaceId: string): Promise<ExecutionProcess[]> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/execution/dev-server/start`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<ExecutionProcess[]>(response);
  },

  // Dev server processes across all sessions of the workspace. The preview is
  // workspace-scoped, so it must not depend on the currently selected session.
  getDevServers: async (workspaceId: string): Promise<ExecutionProcess[]> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/execution/dev-servers`
    );
    return handleApiResponse<ExecutionProcess[]>(response);
  },

  setupGhCli: async (workspaceId: string): Promise<ExecutionProcess> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/integration/github/cli/setup`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<ExecutionProcess, GhCliSetupError>(response);
  },

  runSetupScript: async (
    workspaceId: string,
    hostId?: string | null
  ): Promise<Result<ExecutionProcess, RunScriptError>> => {
    const sessions = await sessionsApi.getByWorkspace(workspaceId, hostId);
    const session =
      sessions[0] ??
      (await sessionsApi.create({ workspace_id: workspaceId }, hostId));

    return sessionsApi.runSetupScript(session.id, hostId);
  },

  runCleanupScript: async (
    workspaceId: string,
    hostId?: string | null
  ): Promise<Result<ExecutionProcess, RunScriptError>> => {
    const response = await makeHostAwareRequest(
      `/api/workspaces/${workspaceId}/execution/cleanup`,
      hostId,
      {
        method: 'POST',
      }
    );
    return handleApiResponseAsResult<ExecutionProcess, RunScriptError>(
      response
    );
  },

  runArchiveScript: async (
    workspaceId: string,
    hostId?: string | null
  ): Promise<Result<ExecutionProcess, RunScriptError>> => {
    const response = await makeHostAwareRequest(
      `/api/workspaces/${workspaceId}/execution/archive`,
      hostId,
      {
        method: 'POST',
      }
    );
    return handleApiResponseAsResult<ExecutionProcess, RunScriptError>(
      response
    );
  },

  getPrComments: async (
    workspaceId: string,
    repoId: string,
    prNumber?: number
  ): Promise<PrCommentsResponse> => {
    const prNumberParam =
      prNumber == null ? '' : `&pr_number=${encodeURIComponent(prNumber)}`;
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/comments?repo_id=${encodeURIComponent(repoId)}${prNumberParam}`
    );
    return handleApiResponse<PrCommentsResponse>(response);
  },

  setPrReviewThreadResolved: async (
    workspaceId: string,
    repoId: string,
    prNumber: number,
    threadId: string,
    resolved: boolean
  ): Promise<void> => {
    const response = await makeRequest(
      `/api/workspaces/${workspaceId}/pull-requests/comments/resolve`,
      {
        method: 'POST',
        body: JSON.stringify({
          repo_id: repoId,
          pr_number: prNumber,
          thread_id: threadId,
          resolved,
        }),
      }
    );
    return handleApiResponse<void>(response);
  },

  /** Mark all coding agent turns for a workspace as seen */
  markSeen: async (workspaceId: string): Promise<void> => {
    const response = await makeRequest(`/api/workspaces/${workspaceId}/seen`, {
      method: 'PUT',
    });
    return handleApiResponse<void>(response);
  },

  /** Create a workspace directly from a pull request */
  createFromPr: async (
    data: CreateWorkspaceFromPrBody
  ): Promise<Result<CreateWorkspaceFromPrResponse, CreateFromPrError>> => {
    const response = await makeRequest('/api/workspaces/from-pr', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponseAsResult<
      CreateWorkspaceFromPrResponse,
      CreateFromPrError
    >(response);
  },
};

// Execution Process APIs
export const executionProcessesApi = {
  getDetails: async (processId: string): Promise<ExecutionProcess> => {
    const response = await makeRequest(`/api/execution-processes/${processId}`);
    return handleApiResponse<ExecutionProcess>(response);
  },

  getRepoStates: async (
    processId: string
  ): Promise<ExecutionProcessRepoState[]> => {
    const response = await makeRequest(
      `/api/execution-processes/${processId}/repo-states`
    );
    return handleApiResponse<ExecutionProcessRepoState[]>(response);
  },

  stopExecutionProcess: async (processId: string): Promise<void> => {
    const response = await makeRequest(
      `/api/execution-processes/${processId}/stop`,
      {
        method: 'POST',
      }
    );
    return handleApiResponse<void>(response);
  },
};

// File System APIs
export const fileSystemApi = {
  list: async (
    path?: string,
    hostId?: string | null
  ): Promise<DirectoryListResponse> => {
    const queryParam = path ? `?path=${encodeURIComponent(path)}` : '';
    const response = await makeHostAwareRequest(
      `/api/filesystem/directory${queryParam}`,
      hostId
    );
    return handleApiResponse<DirectoryListResponse>(response);
  },

  listGitRepos: async (
    path?: string,
    hostId?: string | null
  ): Promise<DirectoryEntry[]> => {
    const queryParam = path ? `?path=${encodeURIComponent(path)}` : '';
    const response = await makeHostAwareRequest(
      `/api/filesystem/git-repos${queryParam}`,
      hostId
    );
    return handleApiResponse<DirectoryEntry[]>(response);
  },
};

// Repo APIs
export const repoApi = {
  list: async (hostId?: string | null): Promise<Repo[]> => {
    const response = await makeHostAwareRequest('/api/repos', hostId);
    return handleApiResponse<Repo[]>(response);
  },

  listRecent: async (hostId?: string | null): Promise<Repo[]> => {
    const response = await makeHostAwareRequest('/api/repos/recent', hostId);
    return handleApiResponse<Repo[]>(response);
  },

  getById: async (repoId: string, hostId?: string | null): Promise<Repo> => {
    const response = await makeHostAwareRequest(`/api/repos/${repoId}`, hostId);
    return handleApiResponse<Repo>(response);
  },

  update: async (
    repoId: string,
    data: UpdateRepo,
    hostId?: string | null
  ): Promise<Repo> => {
    const response = await makeHostAwareRequest(
      `/api/repos/${repoId}`,
      hostId,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<Repo>(response);
  },

  delete: async (repoId: string, hostId?: string | null): Promise<void> => {
    const response = await makeHostAwareRequest(
      `/api/repos/${repoId}`,
      hostId,
      {
        method: 'DELETE',
      }
    );
    return handleApiResponse<void>(response);
  },

  register: async (
    data: {
      path: string;
      display_name?: string;
    },
    hostId?: string | null
  ): Promise<Repo> => {
    const response = await makeHostAwareRequest('/api/repos', hostId, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Repo>(response);
  },

  getBranches: async (
    repoId: string,
    hostId?: string | null,
    opts?: { fetch?: boolean }
  ): Promise<GitBranch[]> => {
    const query = opts?.fetch ? '?fetch=true' : '';
    const response = await makeHostAwareRequest(
      `/api/repos/${repoId}/branches${query}`,
      hostId
    );
    return handleApiResponse<GitBranch[]>(response);
  },

  createLocalBranch: async (
    repoId: string,
    remoteBranch: string,
    hostId?: string | null
  ): Promise<string> => {
    const response = await makeHostAwareRequest(
      `/api/repos/${repoId}/branches/local`,
      hostId,
      {
        method: 'POST',
        body: JSON.stringify({ remote_branch: remoteBranch }),
      }
    );
    return handleApiResponse<string>(response);
  },

  init: async (
    data: {
      parent_path: string;
      folder_name: string;
    },
    hostId?: string | null
  ): Promise<Repo> => {
    const response = await makeHostAwareRequest('/api/repos/init', hostId, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Repo>(response);
  },

  getBatch: async (ids: string[]): Promise<Repo[]> => {
    const response = await makeRequest('/api/repos/batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
    return handleApiResponse<Repo[]>(response);
  },

  openEditor: async (
    repoId: string,
    data: OpenEditorRequest
  ): Promise<OpenEditorResponse> => {
    const response = await makeRequest(`/api/repos/${repoId}/open-editor`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<OpenEditorResponse>(response);
  },

  searchFiles: async (
    repoId: string,
    query: string,
    mode?: SearchMode,
    options?: RequestInit
  ): Promise<SearchResult[]> => {
    const modeParam = mode ? `&mode=${encodeURIComponent(mode)}` : '';
    const response = await makeRequest(
      `/api/repos/${repoId}/search?q=${encodeURIComponent(query)}${modeParam}`,
      options
    );
    return handleApiResponse<SearchResult[]>(response);
  },

  listOpenPrs: async (
    repoId: string,
    remoteName?: string
  ): Promise<Result<PullRequestDetail[], ListPrsError>> => {
    const params = remoteName
      ? `?remote=${encodeURIComponent(remoteName)}`
      : '';
    const response = await makeRequest(`/api/repos/${repoId}/prs${params}`);
    return handleApiResponseAsResult<PullRequestDetail[], ListPrsError>(
      response
    );
  },

  listRemotes: async (repoId: string): Promise<GitRemote[]> => {
    const response = await makeRequest(`/api/repos/${repoId}/remotes`);
    return handleApiResponse<GitRemote[]>(response);
  },
};

// Issue PR linking APIs
export const issuePrsApi = {
  getPrInfo: async (
    url: string
  ): Promise<Result<PullRequestDetail, ListPrsError>> => {
    const response = await makeRequest(
      `/api/repos/pr-info?url=${encodeURIComponent(url)}`
    );
    return handleApiResponseAsResult<PullRequestDetail, ListPrsError>(response);
  },

  linkToIssue: async (data: LinkPrToIssueRequest): Promise<void> => {
    const response = await makeRequest('/api/remote/pull-requests/link', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    await handleApiResponse<void>(response);
  },
};

export const LEGACY_UNVERSIONED_REVISION = 'legacy-unversioned';

export function withCompatibleUserSystemRevisions(
  info: UserSystemInfo
): UserSystemInfo {
  return {
    ...info,
    config_revision: info.config_revision ?? LEGACY_UNVERSIONED_REVISION,
    profiles_revision: info.profiles_revision ?? LEGACY_UNVERSIONED_REVISION,
  };
}

type ProfilesContent = {
  content: string;
  path: string;
  revision: string;
};

export function withCompatibleProfilesRevision(
  profiles: Omit<ProfilesContent, 'revision'> & { revision?: string }
): ProfilesContent {
  return {
    ...profiles,
    revision: profiles.revision ?? LEGACY_UNVERSIONED_REVISION,
  };
}

export function isLegacyUnversionedRevision(revision: string): boolean {
  return revision === LEGACY_UNVERSIONED_REVISION;
}

export function getCompatibleConfigSaveBody(
  config: Config,
  revision: string
): Config | { config: Config; revision: string } {
  return isLegacyUnversionedRevision(revision) ? config : { config, revision };
}

export function getCompatibleProfilesSaveBody(
  content: string,
  revision: string
): string {
  return isLegacyUnversionedRevision(revision)
    ? content
    : JSON.stringify({ content, revision });
}

export function getCompatibleProfilesSaveRevision(
  savedRevision: string,
  requestedRevision: string
): string {
  return isLegacyUnversionedRevision(requestedRevision)
    ? LEGACY_UNVERSIONED_REVISION
    : savedRevision;
}

export async function getCompatibleHostAppearance(
  response: Response,
  loadLegacyUserSystem: () => Promise<UserSystemInfo>
): Promise<HostAppearance> {
  if (response.status === 404) {
    const userSystem = await loadLegacyUserSystem();
    return { primary_color: userSystem.config.primary_color };
  }
  return handleApiResponse<HostAppearance>(response);
}

// Config APIs (backwards compatible with unversioned hosts)
export const configApi = {
  getHostAppearance: async (hostId: string | null): Promise<HostAppearance> => {
    const response = await makeHostAwareRequest(
      '/api/host-appearance',
      hostId,
      {
        cache: 'no-store',
      }
    );
    return getCompatibleHostAppearance(response, () =>
      configApi.getConfig(hostId)
    );
  },
  getConfig: async (hostId: string | null): Promise<UserSystemInfo> => {
    const response = await makeHostAwareRequest('/api/info', hostId, {
      cache: 'no-store',
    });
    return withCompatibleUserSystemRevisions(
      await handleApiResponse<UserSystemInfo>(response)
    );
  },
  saveConfig: async (
    config: Config,
    revision: string,
    hostId: string | null
  ): Promise<{ config: Config; revision: string }> => {
    const legacy = isLegacyUnversionedRevision(revision);
    const response = await makeHostAwareRequest('/api/config', hostId, {
      method: 'PUT',
      body: JSON.stringify(getCompatibleConfigSaveBody(config, revision)),
    });
    if (legacy) {
      return {
        config: await handleApiResponse<Config>(response),
        revision: LEGACY_UNVERSIONED_REVISION,
      };
    }
    return handleApiResponse<{ config: Config; revision: string }>(response);
  },
  checkEditorAvailability: async (
    editorType: EditorType,
    hostId: string | null
  ): Promise<CheckEditorAvailabilityResponse> => {
    const response = await makeHostAwareRequest(
      `/api/editors/check-availability?editor_type=${encodeURIComponent(editorType)}`,
      hostId
    );
    return handleApiResponse<CheckEditorAvailabilityResponse>(response);
  },
  checkAgentAvailability: async (
    agent: BaseCodingAgent,
    hostId: string | null
  ): Promise<AvailabilityInfo> => {
    const response = await makeHostAwareRequest(
      `/api/agents/check-availability?executor=${encodeURIComponent(agent)}`,
      hostId
    );
    return handleApiResponse<AvailabilityInfo>(response);
  },
};

// Task Tags APIs (all tags are global)
export const tagsApi = {
  list: async (
    params?: TagSearchParams,
    hostId?: string | null
  ): Promise<Tag[]> => {
    const queryParam = params?.search
      ? `?search=${encodeURIComponent(params.search)}`
      : '';
    const response = await makeHostAwareRequest(
      `/api/tags${queryParam}`,
      hostId
    );
    return handleApiResponse<Tag[]>(response);
  },

  create: async (data: CreateTag, hostId?: string | null): Promise<Tag> => {
    const response = await makeHostAwareRequest('/api/tags', hostId, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Tag>(response);
  },

  update: async (
    tagId: string,
    data: UpdateTag,
    hostId?: string | null
  ): Promise<Tag> => {
    const response = await makeHostAwareRequest(`/api/tags/${tagId}`, hostId, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Tag>(response);
  },

  delete: async (tagId: string, hostId?: string | null): Promise<void> => {
    const response = await makeHostAwareRequest(`/api/tags/${tagId}`, hostId, {
      method: 'DELETE',
    });
    return handleApiResponse<void>(response);
  },
};

// MCP Servers APIs
export const mcpServersApi = {
  load: async (
    query: McpServerQuery,
    hostId: string | null
  ): Promise<GetMcpServerResponse> => {
    const params = new URLSearchParams(query);
    const response = await makeHostAwareRequest(
      `/api/mcp-config?${params.toString()}`,
      hostId
    );
    return handleApiResponse<GetMcpServerResponse>(response);
  },
  save: async (
    query: McpServerQuery,
    data: UpdateMcpServersBody,
    hostId: string | null
  ): Promise<void> => {
    const params = new URLSearchParams(query);
    // params.set('profile', profile);
    const response = await makeHostAwareRequest(
      `/api/mcp-config?${params.toString()}`,
      hostId,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    if (!response.ok) {
      const errorData = await response.json();
      console.error('[API Error] Failed to save MCP servers', {
        message: errorData.message,
        status: response.status,
        response,
        timestamp: new Date().toISOString(),
      });
      throw new ApiError(
        errorData.message || 'Failed to save MCP servers',
        response.status,
        response
      );
    }
  },
};

// Profiles API
export const profilesApi = {
  load: async (hostId: string | null): Promise<ProfilesContent> => {
    const response = await makeHostAwareRequest('/api/profiles', hostId);
    return withCompatibleProfilesRevision(
      await handleApiResponse<ProfilesContent>(response)
    );
  },
  save: async (
    content: string,
    revision: string,
    hostId: string | null
  ): Promise<string> => {
    const response = await makeHostAwareRequest('/api/profiles', hostId, {
      method: 'PUT',
      body: getCompatibleProfilesSaveBody(content, revision),
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return getCompatibleProfilesSaveRevision(
      await handleApiResponse<string>(response),
      revision
    );
  },
  updateRecentModels: async (
    executor: BaseCodingAgent,
    recentlyUsedModels: ExecutorProfile['recently_used_models'],
    revision: string,
    hostId: string | null
  ): Promise<{ content: string; path: string; revision: string }> => {
    const response = await makeHostAwareRequest(
      '/api/profiles/recent-models',
      hostId,
      {
        method: 'PATCH',
        body: JSON.stringify({
          executor,
          recently_used_models: recentlyUsedModels,
          revision,
        }),
      }
    );
    return handleApiResponse<{
      content: string;
      path: string;
      revision: string;
    }>(response);
  },
};

// Workspace attachments API
export const attachmentsApi = {
  upload: async (attachment: File): Promise<AttachmentResponse> => {
    const formData = new FormData();
    formData.append('image', attachment);

    const response = await makeLocalApiRequest('/api/attachments/upload', {
      method: 'POST',
      body: formData,
      credentials: 'same-origin',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ApiError(
        `Failed to upload attachment: ${errorText}`,
        response.status,
        response
      );
    }

    return handleApiResponse<AttachmentResponse>(response);
  },

  uploadForTask: async (
    taskId: string,
    attachment: File
  ): Promise<AttachmentResponse> => {
    const formData = new FormData();
    formData.append('image', attachment);

    const response = await makeLocalApiRequest(
      `/api/attachments/task/${taskId}/upload`,
      {
        method: 'POST',
        body: formData,
        credentials: 'same-origin',
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new ApiError(
        `Failed to upload attachment: ${errorText}`,
        response.status,
        response
      );
    }

    return handleApiResponse<AttachmentResponse>(response);
  },

  uploadForAttempt: async (
    workspaceId: string,
    sessionId: string,
    attachment: File
  ): Promise<AttachmentResponse> => {
    const formData = new FormData();
    formData.append('image', attachment);

    const response = await makeLocalApiRequest(
      `/api/workspaces/${workspaceId}/attachments/upload?session_id=${sessionId}`,
      {
        method: 'POST',
        body: formData,
        credentials: 'same-origin',
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new ApiError(
        `Failed to upload attachment: ${errorText}`,
        response.status,
        response
      );
    }

    return handleApiResponse<AttachmentResponse>(response);
  },

  delete: async (attachmentId: string): Promise<void> => {
    const response = await makeRequest(`/api/attachments/${attachmentId}`, {
      method: 'DELETE',
    });
    return handleApiResponse<void>(response);
  },

  getTaskAttachments: async (taskId: string): Promise<AttachmentResponse[]> => {
    const response = await makeRequest(`/api/attachments/task/${taskId}`);
    return handleApiResponse<AttachmentResponse[]>(response);
  },

  getAttachmentUrl: (attachmentId: string): string => {
    return `/api/attachments/${attachmentId}/file`;
  },
};

// Approval API
export const approvalsApi = {
  respond: async (
    approvalId: string,
    payload: ApprovalResponse,
    signal?: AbortSignal
  ): Promise<ApprovalStatus> => {
    const res = await makeRequest(`/api/approvals/${approvalId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    return handleApiResponse<ApprovalStatus>(res);
  },
};

// OAuth API
export type AuthMethodsResponse = {
  local_auth_enabled: boolean;
  oauth_providers: string[];
};

export const oauthApi = {
  authMethods: async (): Promise<AuthMethodsResponse> => {
    const response = await makeRequest('/api/auth/methods', {
      cache: 'no-store',
    });
    return handleApiResponse<AuthMethodsResponse>(response);
  },

  handoffInit: async (
    provider: string,
    returnTo: string
  ): Promise<{ handoff_id: string; authorize_url: string }> => {
    const response = await makeRequest('/api/auth/handoff/init', {
      method: 'POST',
      body: JSON.stringify({ provider, return_to: returnTo }),
    });
    return handleApiResponse<{ handoff_id: string; authorize_url: string }>(
      response
    );
  },

  status: async (): Promise<StatusResponse> => {
    const response = await makeRequest('/api/auth/status', {
      cache: 'no-store',
    });
    return handleApiResponse<StatusResponse>(response);
  },

  localLogin: async (
    email: string,
    password: string
  ): Promise<ProfileResponse> => {
    const response = await makeRequest('/api/auth/local/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return handleApiResponse<ProfileResponse>(response);
  },

  logout: async (): Promise<void> => {
    const response = await makeRequest('/api/auth/logout', {
      method: 'POST',
    });
    if (!response.ok) {
      throw new ApiError(
        `Logout failed with status ${response.status}`,
        response.status,
        response
      );
    }
  },

  /** Returns the current access token for the remote server (auto-refreshes if needed) */
  getToken: async (): Promise<TokenResponse> => {
    const response = await makeRequest('/api/auth/token');
    if (response.status === 401) {
      throw new ApiError('Unauthorized', 401, response);
    }
    return handleApiResponse<TokenResponse>(response);
  },

  /** Returns the user ID of the currently authenticated user */
  getCurrentUser: async (): Promise<CurrentUserResponse> => {
    const response = await makeRequest('/api/auth/user');
    return handleApiResponse<CurrentUserResponse>(response);
  },
};

/**
 * @deprecated Use `tokenManager.getToken()` from
 * `@/shared/lib/auth/tokenManager` instead.
 * This function does not handle 401 responses or token refresh coordination.
 */
export async function getCachedToken(): Promise<string | null> {
  const { tokenManager } = await import('@/shared/lib/auth/tokenManager');
  return tokenManager.getToken();
}

const handleRemoteResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    let errorMessage = `Request failed with status ${response.status}`;

    try {
      const body = (await response.json()) as {
        error?: string;
        message?: string;
      };
      errorMessage = body.error || body.message || errorMessage;
    } catch {
      errorMessage = response.statusText || errorMessage;
    }

    throw new ApiError(errorMessage, response.status, response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};

// Organizations API
export const organizationsApi = {
  getMembers: async (
    orgId: string
  ): Promise<OrganizationMemberWithProfile[]> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/members`
    );
    const result = await handleRemoteResponse<ListMembersResponse>(response);
    return result.members;
  },

  getUserOrganizations: async (): Promise<ListOrganizationsResponse> => {
    const response = await makeRemoteRequest('/v1/organizations');
    return handleRemoteResponse<ListOrganizationsResponse>(response);
  },

  createOrganization: async (
    data: CreateOrganizationRequest
  ): Promise<CreateOrganizationResponse> => {
    const response = await makeRemoteRequest('/v1/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleRemoteResponse<CreateOrganizationResponse>(response);
  },

  createInvitation: async (
    orgId: string,
    data: CreateInvitationRequest
  ): Promise<CreateInvitationResponse> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/invitations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }
    );
    return handleRemoteResponse<CreateInvitationResponse>(response);
  },

  removeMember: async (orgId: string, userId: string): Promise<void> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/members/${userId}`,
      {
        method: 'DELETE',
      }
    );
    return handleRemoteResponse<void>(response);
  },

  updateMemberRole: async (
    orgId: string,
    userId: string,
    data: UpdateMemberRoleRequest
  ): Promise<UpdateMemberRoleResponse> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/members/${userId}/role`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }
    );
    return handleRemoteResponse<UpdateMemberRoleResponse>(response);
  },

  listInvitations: async (orgId: string): Promise<Invitation[]> => {
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/invitations`
    );
    const result =
      await handleRemoteResponse<ListInvitationsResponse>(response);
    return result.invitations;
  },

  revokeInvitation: async (
    orgId: string,
    invitationId: string
  ): Promise<void> => {
    const body: RevokeInvitationRequest = { invitation_id: invitationId };
    const response = await makeRemoteRequest(
      `/v1/organizations/${orgId}/invitations/revoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    return handleRemoteResponse<void>(response);
  },

  deleteOrganization: async (orgId: string): Promise<void> => {
    const response = await makeRemoteRequest(`/v1/organizations/${orgId}`, {
      method: 'DELETE',
    });
    return handleRemoteResponse<void>(response);
  },
};

export const userNotificationPreferencesApi = {
  get: async (): Promise<UserNotificationPreference> => {
    const response = await makeRemoteRequest(
      '/v1/user-notification-preferences'
    );
    if (!response.ok) {
      throw new ApiError(
        response.statusText || 'Failed to load notification settings',
        response.status,
        response
      );
    }
    return response.json();
  },

  update: async (
    data: UpdateUserNotificationPreferenceRequest
  ): Promise<UserNotificationPreference> => {
    const response = await makeRemoteRequest(
      '/v1/user-notification-preferences',
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    );
    if (!response.ok) {
      throw new ApiError(
        response.statusText || 'Failed to update notification settings',
        response.status,
        response
      );
    }
    return response.json();
  },
};

export const remoteProjectsApi = {
  listByOrganization: async (
    organizationId: string
  ): Promise<RemoteProject[]> => {
    const response = await makeRequest(
      `/api/remote/projects?organization_id=${encodeURIComponent(organizationId)}`
    );
    const result =
      await handleApiResponse<ListRemoteProjectsResponse>(response);
    return result.projects;
  },
};

// Scratch API
export const scratchApi = {
  create: async (
    scratchType: ScratchType,
    id: string,
    data: CreateScratch
  ): Promise<Scratch> => {
    const response = await makeRequest(`/api/scratch/${scratchType}/${id}`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<Scratch>(response);
  },

  get: async (
    scratchType: ScratchType,
    id: string,
    hostId?: string | null
  ): Promise<Scratch> => {
    const response = await makeHostAwareRequest(
      `/api/scratch/${scratchType}/${id}`,
      hostId
    );
    return handleApiResponse<Scratch>(response);
  },

  update: async (
    scratchType: ScratchType,
    id: string,
    data: UpdateScratch,
    hostId?: string | null
  ): Promise<void> => {
    const response = await makeHostAwareRequest(
      `/api/scratch/${scratchType}/${id}`,
      hostId,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<void>(response);
  },

  delete: async (scratchType: ScratchType, id: string): Promise<void> => {
    const response = await makeRequest(`/api/scratch/${scratchType}/${id}`, {
      method: 'DELETE',
    });
    return handleApiResponse<void>(response);
  },

  getStreamUrl: (scratchType: ScratchType, id: string): string =>
    `/api/scratch/${scratchType}/${id}/stream/ws`,
};

// Agents API
export const agentsApi = {
  getDiscoveredOptionsStreamUrl: (
    agent: BaseCodingAgent,
    opts?: {
      workspaceId?: string;
      sessionId?: string;
      repoId?: string;
      hostScopeKey?: string;
    }
  ): string => {
    const params = new URLSearchParams();
    params.set('executor', agent);
    if (opts?.workspaceId) params.set('workspace_id', opts.workspaceId);
    if (opts?.sessionId) params.set('session_id', opts.sessionId);
    if (opts?.repoId) params.set('repo_id', opts.repoId);
    // Client-side stream identity must include the immutable target host so a
    // host switch cannot retain the previous host's stream state. The server
    // safely ignores this routing-only query field.
    if (opts?.hostScopeKey) params.set('_host_scope', opts.hostScopeKey);

    return `/api/agents/discovered-options/ws?${params.toString()}`;
  },

  getPresetOptions: async (
    query: AgentPresetOptionsQuery,
    hostId: string | null
  ): Promise<ExecutorConfig> => {
    const params = new URLSearchParams();
    params.set('executor', query.executor);
    if (query.variant) params.set('variant', query.variant);
    const response = await makeHostAwareRequest(
      `/api/agents/preset-options?${params.toString()}`,
      hostId
    );
    return handleApiResponse<ExecutorConfig>(response);
  },
};

// Queue API for session follow-up messages
export const queueApi = {
  /**
   * Queue a follow-up message to be executed when current execution finishes
   */
  queue: async (
    sessionId: string,
    data: DraftFollowUpData
  ): Promise<QueueStatus> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/queue`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleApiResponse<QueueStatus>(response);
  },

  /**
   * Steer / "send now": interrupt the running turn and run this message
   * immediately instead of waiting for the current turn to finish.
   */
  steer: async (
    sessionId: string,
    data: DraftFollowUpData
  ): Promise<QueueStatus> => {
    const response = await makeRequest(
      `/api/sessions/${sessionId}/queue/steer`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return handleApiResponse<QueueStatus>(response);
  },

  /**
   * Steer an already-queued message: promote it to the front and run it next,
   * interrupting the current turn instead of waiting its turn in the queue.
   */
  steerQueued: async (
    sessionId: string,
    messageId: string
  ): Promise<QueueStatus> => {
    const response = await makeRequest(
      `/api/sessions/${sessionId}/queue/steer-queued`,
      {
        method: 'POST',
        body: JSON.stringify({ message_id: messageId }),
      }
    );
    return handleApiResponse<QueueStatus>(response);
  },

  /**
   * Reorder the queue to the given message id order (front first).
   */
  reorder: async (
    sessionId: string,
    messageIds: string[]
  ): Promise<QueueStatus> => {
    const response = await makeRequest(
      `/api/sessions/${sessionId}/queue/reorder`,
      {
        method: 'POST',
        body: JSON.stringify({ message_ids: messageIds }),
      }
    );
    return handleApiResponse<QueueStatus>(response);
  },

  /**
   * Cancel all queued follow-up messages
   */
  cancel: async (sessionId: string): Promise<QueueStatus> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/queue`, {
      method: 'DELETE',
    });
    return handleApiResponse<QueueStatus>(response);
  },

  /**
   * Cancel a single queued follow-up message by id
   */
  cancelOne: async (
    sessionId: string,
    messageId: string
  ): Promise<QueueStatus> => {
    const response = await makeRequest(
      `/api/sessions/${sessionId}/queue?message_id=${encodeURIComponent(messageId)}`,
      {
        method: 'DELETE',
      }
    );
    return handleApiResponse<QueueStatus>(response);
  },

  /**
   * Get the current queue status for a session
   */
  getStatus: async (sessionId: string): Promise<QueueStatus> => {
    const response = await makeRequest(`/api/sessions/${sessionId}/queue`);
    return handleApiResponse<QueueStatus>(response);
  },
};

// Relay API
export const relayApi = {
  getEnrollmentCode: async (): Promise<{ enrollment_code: string }> => {
    const response = await makeRequest(
      '/api/relay-auth/server/enrollment-code',
      {
        method: 'POST',
      }
    );
    return handleApiResponse<{ enrollment_code: string }>(response);
  },

  listPairedClients: async (): Promise<RelayPairedClient[]> => {
    const response = await makeRequest('/api/relay-auth/server/clients');
    const body =
      await handleApiResponse<ListRelayPairedClientsResponse>(response);
    return body.clients;
  },

  removePairedClient: async (
    clientId: string
  ): Promise<RemoveRelayPairedClientResponse> => {
    const response = await makeRequest(
      `/api/relay-auth/server/clients/${encodeURIComponent(clientId)}`,
      {
        method: 'DELETE',
      }
    );
    return handleApiResponse<RemoveRelayPairedClientResponse>(response);
  },

  pairRelayHost: async (
    payload: PairRelayHostRequest
  ): Promise<PairRelayHostResponse> => {
    const response = await makeRequest('/api/relay-auth/client/pair', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return handleApiResponse<PairRelayHostResponse>(response);
  },

  listPairedRelayHosts: async (): Promise<RelayPairedHost[]> => {
    const response = await makeRequest('/api/relay-auth/client/hosts');
    const body =
      await handleApiResponse<ListRelayPairedHostsResponse>(response);
    return body.hosts;
  },

  getSelfRelayHostId: async (): Promise<string | null> => {
    const response = await makeRequest('/api/relay-auth/client/self-host');
    const body = await handleApiResponse<SelfRelayHostResponse>(response);
    return body.host_id;
  },

  removePairedRelayHost: async (
    hostId: string
  ): Promise<RemoveRelayPairedHostResponse> => {
    const response = await makeRequest(
      `/api/relay-auth/client/hosts/${encodeURIComponent(hostId)}`,
      {
        method: 'DELETE',
      }
    );
    return handleApiResponse<RemoveRelayPairedHostResponse>(response);
  },

  openRemoteWorkspaceInEditor: async (
    payload: OpenRemoteWorkspaceInEditorRequest
  ): Promise<OpenRemoteEditorResponse> => {
    const response = await makeRequest('/api/open-remote-editor/workspace', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return handleApiResponse<OpenRemoteEditorResponse>(response);
  },
};

// Releases API (GitHub releases proxy)
export interface GitHubRelease {
  name: string;
  tag_name: string;
  published_at: string;
  body: string;
}

interface ReleasesResponse {
  releases: GitHubRelease[];
}

export const releasesApi = {
  list: async (): Promise<GitHubRelease[]> => {
    const response = await makeRequest('/api/releases');
    const result = await handleApiResponse<ReleasesResponse>(response);
    return result.releases;
  },
};

// Search API (multi-repo file search)
export const searchApi = {
  searchFiles: async (
    repoIds: string[],
    query: string,
    mode?: SearchMode,
    options?: RequestInit,
    hostId?: string | null
  ): Promise<SearchResult[]> => {
    const repoIdsParam = repoIds.join(',');
    const modeParam = mode ? `&mode=${encodeURIComponent(mode)}` : '';
    const response = await makeHostAwareRequest(
      `/api/search?q=${encodeURIComponent(query)}&repo_ids=${encodeURIComponent(repoIdsParam)}${modeParam}`,
      hostId,
      options
    );
    return handleApiResponse<SearchResult[]>(response);
  },
};
