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
  script: string;
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

export interface AutomationState {
  // Master switch. When false the worker installs no poll timers (idles).
  enabled: boolean;
  connectors: AutomationConnector[];
  rules: AutomationRule[];
  retryQueue: AutomationRetryItem[];
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
  },
  github: {
    token: '',
    owner: '',
    repo: '',
    filter: 'assigned',
    state: 'open',
    intervalSeconds: 120,
    cursorTs: '',
    seenIds: [],
    limit: 50,
    includePullRequests: false,
    reviewPrs: false,
    backfill: false,
  },
};
