// Types mirroring the standalone automation worker (packages/automation-worker).
// The worker is a plain Node service — its state is NOT ts-rs generated — so
// these shapes are maintained by hand and must track server.mjs's state model.
// Credential fields are returned masked as the string `__stored__`.

export type AutomationConnectorType = 'slack' | 'github' | 'vibe_kanban';

export interface AutomationConnector {
  id: string;
  name: string;
  type: AutomationConnectorType | string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  kind?: 'script' | 'condition' | 'github_issue_sync' | string;
  config?: GithubIssueSyncRuleConfig | Record<string, unknown>;
  script: string;
}

export interface GithubStatusMapping {
  vibeStatusId: string;
  githubOptionId: string;
}

export interface GithubIssueSyncRuleConfig {
  githubConnectorId: string;
  vibeConnectorId: string;
  githubProjectId: string;
  includeIssuesFromOtherRepositories: boolean;
  githubStatusFieldId: string;
  statusMappings: GithubStatusMapping[];
  fields: {
    title: boolean;
    description: boolean;
    status: boolean;
    comments: boolean;
  };
}

export interface GithubProjectMetadata {
  id: string;
  number: number;
  title: string;
  statusField: {
    id: string;
    options: Array<{ id: string; name: string }>;
  } | null;
}

export interface GithubProjectsMetadata {
  projects: GithubProjectMetadata[];
}

export interface LinkGithubIssueRequest {
  ruleId: string;
  mode: 'existing' | 'create';
  issueId: string;
  url?: string;
  title: string;
  description: string | null;
  statusId: string;
  vibeUpdatedAt: string;
}

export interface AutomationRetryItem {
  id: string;
  ruleId: string;
  connectorId: string | null;
  source: string | null;
  label: string | null;
  attempts: number;
  maxAttempts: number;
  status: 'pending' | 'exhausted' | string;
  lastError: string | null;
  enqueuedAt: number;
  updatedAt: number;
  nextAttemptAt: number | null;
}

export type AutomationRoutineTrigger =
  | { type: 'schedule'; at?: string; cron?: string; timezone: string }
  | {
      type: 'issue_created' | 'execution_completed' | 'workspace_archived';
    };

export type AutomationRoutineAction =
  | {
      type: 'create_issue';
      connectorId: string;
      input: { title: string; description?: string };
    }
  | {
      type: 'start_workspace';
      connectorId: string;
      targetHostId: string;
      input: Record<string, unknown> & {
        max_execution_seconds: number;
      };
    }
  | {
      type: 'send_prompt';
      connectorId: string;
      targetHostId: string;
      input: Record<string, unknown> & {
        sessionId: string;
        prompt: string;
        scope: { projectId: string; repositoryIds: string[] };
      };
    }
  | {
      type: 'notification';
      connectorId: string;
      targetHostId: string;
      input: { title: string; message: string; workspace_id?: string };
    };

export interface AutomationRoutine {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationRoutineTrigger;
  condition: Record<string, unknown> | null;
  action: AutomationRoutineAction;
}

export interface AutomationRoutineRun {
  id: string;
  routineId: string;
  status: string;
  trigger: Record<string, unknown>;
  targetHostId: string | null;
  startedAt: string;
  finishedAt?: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
}

export interface AutomationState {
  // Master switch. When false the worker installs no poll timers (idles).
  enabled: boolean;
  connectors: AutomationConnector[];
  rules: AutomationRule[];
  retryQueue: AutomationRetryItem[];
  routines: AutomationRoutine[];
  routineRuns: AutomationRoutineRun[];
}

export interface AutomationLogEntry {
  id: string;
  ts: string;
  level: string;
  message: string;
  meta: Record<string, unknown>;
}

// Default config blobs shown when adding a new connector of each type — mirror
// the worker's defaultState so the editor starts from a valid shape.
export const AUTOMATION_CONNECTOR_DEFAULTS: Record<
  AutomationConnectorType,
  Record<string, unknown>
> = {
  slack: {
    token: '',
    channelId: '',
    intervalSeconds: 60,
    cursorTs: '0',
    limit: 25,
  },
  vibe_kanban: {
    baseUrl: '',
    tokenUrl: '',
    bearerToken: '',
    projectId: '',
    statusId: '',
    hostBridges: {},
  },
  github: {
    token: '',
    owner: '',
    repo: '',
    filter: 'assigned',
    state: 'open',
    intervalSeconds: 60,
    cursorTs: '',
    seenIds: [],
    limit: 50,
    includePullRequests: false,
    reviewPrs: false,
    backfill: false,
  },
};
