import type {
  Config,
  GetMcpServerResponse,
  GitBranch,
  GitRemote,
  McpServerQuery,
  Repo,
  RepoRemoteStatus,
  UpdateMcpServersBody,
  UpdateRepo,
  UserSystemInfo,
  AgentMemorySyncLogEntry,
  AgentMemorySyncStatus,
  AgentMemoryMutation,
  CreateAgentMemoryMutationRequest,
} from 'shared/types';
import type { AppRuntime } from '@/shared/hooks/useAppRuntime';
import {
  handleApiResponse,
  getCompatibleConfigSaveBody,
  getCompatibleProfilesSaveBody,
  getCompatibleProfilesSaveRevision,
  isLegacyUnversionedRevision,
  LEGACY_UNVERSIONED_REVISION,
  withCompatibleProfilesRevision,
  withCompatibleUserSystemRevisions,
} from './api';
import {
  makeLocalApiRequest,
  type LocalApiRequestOptions,
} from './localApiTransport';
import type {
  AutomationConnector,
  AutomationLogEntry,
  GithubProjectsMetadata,
  LinkGithubIssueRequest,
  AutomationRetryItem,
  AutomationRoutine,
  AutomationRule,
  AutomationState,
} from './automationWorker';

export type MachineTarget =
  | {
      kind: 'local';
      id: 'local';
      apiHostId: null;
      label: string;
    }
  | {
      kind: 'remote';
      id: string;
      apiHostId: string;
      label: string;
    };

export interface MachineClient {
  target: MachineTarget;
  queryScopeKey: readonly ['machine', string];
  getConfig: () => Promise<UserSystemInfo>;
  saveConfig: (
    config: Config,
    revision: string
  ) => Promise<{ config: Config; revision: string }>;
  listRepos: () => Promise<Repo[]>;
  updateRepo: (repoId: string, data: UpdateRepo) => Promise<Repo>;
  deleteRepo: (repoId: string) => Promise<void>;
  registerRepo: (data: {
    path: string;
    display_name?: string;
  }) => Promise<Repo>;
  getRepoBranches: (repoId: string) => Promise<GitBranch[]>;
  createLocalBranch: (repoId: string, remoteBranch: string) => Promise<string>;
  listRepoRemotes: (repoId: string) => Promise<GitRemote[]>;
  getRepoRemoteStatus: (repoId: string) => Promise<RepoRemoteStatus>;
  fetchRepoRemote: (repoId: string) => Promise<RepoRemoteStatus>;
  pushRepoBranch: (
    repoId: string,
    force?: boolean
  ) => Promise<RepoRemoteStatus>;
  loadProfiles: () => Promise<{
    content: string;
    path: string;
    revision: string;
  }>;
  saveProfiles: (content: string, revision: string) => Promise<string>;
  loadMcpServers: (query: McpServerQuery) => Promise<GetMcpServerResponse>;
  saveMcpServers: (
    query: McpServerQuery,
    data: UpdateMcpServersBody
  ) => Promise<void>;
  // Automation worker (packages/automation-worker), proxied via /api/automation/*.
  // It returns raw JSON (not the ApiResponse envelope), so these use a dedicated
  // parser instead of handleApiResponse.
  getAutomationState: () => Promise<AutomationState>;
  setAutomationEnabled: (enabled: boolean) => Promise<AutomationState>;
  saveAutomationConnector: (
    connector: AutomationConnector
  ) => Promise<AutomationState>;
  deleteAutomationConnector: (id: string) => Promise<AutomationState>;
  saveAutomationRule: (rule: AutomationRule) => Promise<AutomationState>;
  deleteAutomationRule: (id: string) => Promise<AutomationState>;
  saveAutomationRoutine: (
    routine: AutomationRoutine
  ) => Promise<AutomationState>;
  deleteAutomationRoutine: (id: string) => Promise<AutomationState>;
  runAutomationRoutine: (id: string) => Promise<unknown>;
  pollAutomationConnector: (id: string) => Promise<unknown>;
  getGithubProjectsMetadata: (
    connectorId: string
  ) => Promise<GithubProjectsMetadata>;
  linkGithubIssue: (request: LinkGithubIssueRequest) => Promise<unknown>;
  getAutomationLogs: () => Promise<AutomationLogEntry[]>;
  getAutomationRetryQueue: () => Promise<AutomationRetryItem[]>;
  processAutomationRetries: (includeExhausted: boolean) => Promise<unknown>;
  getAgentMemorySyncStatus: () => Promise<AgentMemorySyncStatus>;
  getAgentMemorySyncLogs: (
    limit?: number
  ) => Promise<AgentMemorySyncLogEntry[]>;
  runAgentMemorySync: () => Promise<{ started: boolean }>;
  listAgentMemoryMutations: () => Promise<AgentMemoryMutation[]>;
  createAgentMemoryMutation: (
    request: CreateAgentMemoryMutationRequest
  ) => Promise<AgentMemoryMutation>;
}

function getMachineRequestOptions(
  runtime: AppRuntime,
  target: MachineTarget
): LocalApiRequestOptions {
  if (runtime === 'remote') {
    return {
      hostScope: 'none',
      relayHostId: target.apiHostId,
    };
  }

  if (target.apiHostId) {
    return {
      hostScope: 'explicit',
      hostId: target.apiHostId,
    };
  }

  return {
    hostScope: 'none',
  };
}

async function makeMachineRequest(
  runtime: AppRuntime,
  target: MachineTarget,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return makeLocalApiRequest(path, {
    ...options,
    headers,
    ...getMachineRequestOptions(runtime, target),
  });
}

// The automation worker replies with bare JSON (its own state model), not the
// Vibe Kanban ApiResponse envelope, so parse it directly. A non-2xx surfaces the
// worker's error text (or the proxy's gateway message when it is unreachable).
async function readAutomationJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Automation worker error (${response.status})`);
  }
  return (await response.json()) as T;
}

export function createMachineClient(
  runtime: AppRuntime,
  target: MachineTarget
): MachineClient {
  const queryScopeKey = ['machine', target.id] as const;

  return {
    target,
    queryScopeKey,
    getConfig: async () =>
      withCompatibleUserSystemRevisions(
        await handleApiResponse<UserSystemInfo>(
          await makeMachineRequest(runtime, target, '/api/info', {
            cache: 'no-store',
          })
        )
      ),
    saveConfig: async (config, revision) => {
      const legacy = isLegacyUnversionedRevision(revision);
      const response = await makeMachineRequest(
        runtime,
        target,
        '/api/config',
        {
          method: 'PUT',
          body: JSON.stringify(getCompatibleConfigSaveBody(config, revision)),
        }
      );
      if (legacy) {
        return {
          config: await handleApiResponse<Config>(response),
          revision: LEGACY_UNVERSIONED_REVISION,
        };
      }
      return handleApiResponse<{ config: Config; revision: string }>(response);
    },
    listRepos: async () =>
      handleApiResponse<Repo[]>(
        await makeMachineRequest(runtime, target, '/api/repos')
      ),
    updateRepo: async (repoId, data) =>
      handleApiResponse<Repo>(
        await makeMachineRequest(runtime, target, `/api/repos/${repoId}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        })
      ),
    deleteRepo: async (repoId) =>
      handleApiResponse<void>(
        await makeMachineRequest(runtime, target, `/api/repos/${repoId}`, {
          method: 'DELETE',
        })
      ),
    registerRepo: async (data) =>
      handleApiResponse<Repo>(
        await makeMachineRequest(runtime, target, '/api/repos', {
          method: 'POST',
          body: JSON.stringify(data),
        })
      ),
    getRepoBranches: async (repoId) =>
      handleApiResponse<GitBranch[]>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/repos/${repoId}/branches`
        )
      ),
    createLocalBranch: async (repoId, remoteBranch) =>
      handleApiResponse<string>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/repos/${repoId}/branches/local`,
          {
            method: 'POST',
            body: JSON.stringify({ remote_branch: remoteBranch }),
          }
        )
      ),
    listRepoRemotes: async (repoId) =>
      handleApiResponse<GitRemote[]>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/repos/${repoId}/remotes`
        )
      ),
    getRepoRemoteStatus: async (repoId) =>
      handleApiResponse<RepoRemoteStatus>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/repos/${repoId}/remote-status`,
          { cache: 'no-store' }
        )
      ),
    fetchRepoRemote: async (repoId) =>
      handleApiResponse<RepoRemoteStatus>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/repos/${repoId}/fetch`,
          {
            method: 'POST',
          }
        )
      ),
    pushRepoBranch: async (repoId, force = false) =>
      handleApiResponse<RepoRemoteStatus>(
        await makeMachineRequest(runtime, target, `/api/repos/${repoId}/push`, {
          method: 'POST',
          body: JSON.stringify({ force }),
        })
      ),
    loadProfiles: async () =>
      withCompatibleProfilesRevision(
        await handleApiResponse<{
          content: string;
          path: string;
          revision: string;
        }>(await makeMachineRequest(runtime, target, '/api/profiles'))
      ),
    saveProfiles: async (content, revision) => {
      const savedRevision = await handleApiResponse<string>(
        await makeMachineRequest(runtime, target, '/api/profiles', {
          method: 'PUT',
          body: getCompatibleProfilesSaveBody(content, revision),
          headers: {
            'Content-Type': 'application/json',
          },
        })
      );
      return getCompatibleProfilesSaveRevision(savedRevision, revision);
    },
    loadMcpServers: async (query) => {
      const params = new URLSearchParams(query);
      return handleApiResponse<GetMcpServerResponse>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/mcp-config?${params.toString()}`
        )
      );
    },
    saveMcpServers: async (query, data) => {
      const params = new URLSearchParams(query);
      await handleApiResponse<void>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/mcp-config?${params.toString()}`,
          {
            method: 'POST',
            body: JSON.stringify(data),
          }
        )
      );
    },
    getAgentMemorySyncStatus: async () =>
      readAutomationJson<AgentMemorySyncStatus>(
        await makeMachineRequest(
          runtime,
          target,
          '/api/agent-memory-sync/status',
          {
            cache: 'no-store',
          }
        )
      ),
    getAgentMemorySyncLogs: async (limit = 200) =>
      readAutomationJson<AgentMemorySyncLogEntry[]>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/agent-memory-sync/logs?limit=${limit}`,
          { cache: 'no-store' }
        )
      ),
    runAgentMemorySync: async () =>
      readAutomationJson<{ started: boolean }>(
        await makeMachineRequest(
          runtime,
          target,
          '/api/agent-memory-sync/run-all',
          {
            method: 'POST',
          }
        )
      ),
    listAgentMemoryMutations: async () =>
      readAutomationJson<AgentMemoryMutation[]>(
        await makeMachineRequest(
          runtime,
          target,
          '/api/agent-memory-sync/mutations',
          { cache: 'no-store' }
        )
      ),
    createAgentMemoryMutation: async (request) =>
      readAutomationJson<AgentMemoryMutation>(
        await makeMachineRequest(
          runtime,
          target,
          '/api/agent-memory-sync/mutations',
          { method: 'POST', body: JSON.stringify(request) }
        )
      ),
    getAutomationState: async () =>
      readAutomationJson<AutomationState>(
        await makeMachineRequest(runtime, target, '/api/automation/state', {
          cache: 'no-store',
        })
      ),
    setAutomationEnabled: async (enabled) =>
      readAutomationJson<AutomationState>(
        await makeMachineRequest(runtime, target, '/api/automation/settings', {
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        })
      ),
    saveAutomationConnector: async (connector) =>
      readAutomationJson<AutomationState>(
        await makeMachineRequest(
          runtime,
          target,
          '/api/automation/connectors',
          {
            method: 'POST',
            body: JSON.stringify(connector),
          }
        )
      ),
    deleteAutomationConnector: async (id) =>
      readAutomationJson<AutomationState>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/automation/connectors/${encodeURIComponent(id)}`,
          { method: 'DELETE' }
        )
      ),
    saveAutomationRule: async (rule) =>
      readAutomationJson<AutomationState>(
        await makeMachineRequest(runtime, target, '/api/automation/rules', {
          method: 'POST',
          body: JSON.stringify(rule),
        })
      ),
    deleteAutomationRule: async (id) =>
      readAutomationJson<AutomationState>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/automation/rules/${encodeURIComponent(id)}`,
          { method: 'DELETE' }
        )
      ),
    saveAutomationRoutine: async (routine) =>
      readAutomationJson<AutomationState>(
        await makeMachineRequest(runtime, target, '/api/automation/routines', {
          method: 'POST',
          body: JSON.stringify(routine),
        })
      ),
    deleteAutomationRoutine: async (id) =>
      readAutomationJson<AutomationState>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/automation/routines/${encodeURIComponent(id)}`,
          { method: 'DELETE' }
        )
      ),
    runAutomationRoutine: async (id) =>
      readAutomationJson<unknown>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/automation/routines/${encodeURIComponent(id)}/run`,
          { method: 'POST' }
        )
      ),
    pollAutomationConnector: async (id) =>
      readAutomationJson<unknown>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/automation/poll/${encodeURIComponent(id)}`,
          { method: 'POST' }
        )
      ),
    getGithubProjectsMetadata: async (connectorId) =>
      readAutomationJson<GithubProjectsMetadata>(
        await makeMachineRequest(
          runtime,
          target,
          `/api/automation/github/projects?connectorId=${encodeURIComponent(
            connectorId
          )}`,
          { cache: 'no-store' }
        )
      ),
    linkGithubIssue: async (request) =>
      readAutomationJson<unknown>(
        await makeMachineRequest(
          runtime,
          target,
          '/api/automation/github/issues/link',
          { method: 'POST', body: JSON.stringify(request) }
        )
      ),
    getAutomationLogs: async () =>
      readAutomationJson<AutomationLogEntry[]>(
        await makeMachineRequest(runtime, target, '/api/automation/logs', {
          cache: 'no-store',
        })
      ),
    getAutomationRetryQueue: async () =>
      readAutomationJson<AutomationRetryItem[]>(
        await makeMachineRequest(
          runtime,
          target,
          '/api/automation/retry-queue',
          { cache: 'no-store' }
        )
      ),
    processAutomationRetries: async (includeExhausted) =>
      readAutomationJson<unknown>(
        await makeMachineRequest(
          runtime,
          target,
          '/api/automation/retry-queue/process',
          {
            method: 'POST',
            body: JSON.stringify({ includeExhausted }),
          }
        )
      ),
  };
}
