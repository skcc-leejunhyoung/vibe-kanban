import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentMemoryKind,
  AgentMemoryMutation,
  AgentMemoryMutationOperation,
  AgentMemoryScope,
  AgentMemorySyncConfig,
  AgentMemorySyncLogEntry,
  AgentMemorySyncStatus,
} from 'shared/types';
import type { ProjectStatus } from 'shared/remote-types';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { withDisplayTimeZone } from '@vibe/ui/lib/datetime';
import { cn } from '@/shared/lib/utils';
import {
  SettingsCard,
  SettingsCheckbox,
  SettingsField,
  SettingsInput,
  SettingsSelect,
  SettingsTextarea,
} from './SettingsComponents';
import { useSettingsMachineClient } from './SettingsHostContext';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import {
  AUTOMATION_CONNECTOR_DEFAULTS,
  type AutomationConnector,
  type AutomationConnectorType,
  type AutomationLogEntry,
  type AutomationRule,
  type AutomationRoutine,
  type AutomationState,
  type GithubIssueSyncRuleConfig,
  type GithubProjectMetadata,
} from '@/shared/lib/automationWorker';
import type { MachineClient } from '@/shared/lib/machineClient';
import { listProjectStatuses } from '@/shared/lib/remoteApi';

const CONNECTOR_TYPES: AutomationConnectorType[] = [
  'slack',
  'github',
  'vibe_kanban',
];

interface ConnectorDraft {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  configText: string;
  isNew: boolean;
}

interface RuleDraft {
  id: string;
  name: string;
  enabled: boolean;
  kind: string;
  config: Record<string, unknown>;
  script: string;
  isNew: boolean;
}

interface RoutineDraft {
  id: string;
  name: string;
  enabled: boolean;
  definitionText: string;
  isNew: boolean;
}

const EMPTY_GITHUB_SYNC_CONFIG: GithubIssueSyncRuleConfig = {
  githubConnectorId: 'github-default',
  vibeConnectorId: 'vibe-default',
  githubProjectId: '',
  includeIssuesFromOtherRepositories: false,
  githubStatusFieldId: '',
  statusMappings: [],
  fields: { title: true, description: true, status: true, comments: true },
};

function asGithubSyncConfig(
  value: Record<string, unknown>
): GithubIssueSyncRuleConfig {
  return {
    ...EMPTY_GITHUB_SYNC_CONFIG,
    ...value,
    statusMappings: Array.isArray(value.statusMappings)
      ? (value.statusMappings as GithubIssueSyncRuleConfig['statusMappings'])
      : [],
    fields: {
      ...EMPTY_GITHUB_SYNC_CONFIG.fields,
      ...(typeof value.fields === 'object' && value.fields ? value.fields : {}),
    },
  };
}

function GithubIssueSyncRuleEditor({
  machineClient,
  connectors,
  value,
  onChange,
}: {
  machineClient: MachineClient;
  connectors: AutomationConnector[];
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const config = asGithubSyncConfig(value);
  const [projects, setProjects] = useState<GithubProjectMetadata[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [vibeStatuses, setVibeStatuses] = useState<ProjectStatus[]>([]);
  const githubConnectors = connectors.filter((item) => item.type === 'github');
  const vibeConnectors = connectors.filter(
    (item) => item.type === 'vibe_kanban'
  );
  const selectedProject = projects.find(
    (project) => project.id === config.githubProjectId
  );
  const vibeConnector = vibeConnectors.find(
    (item) => item.id === config.vibeConnectorId
  );
  const vibeProjectId = String(vibeConnector?.config.projectId ?? '');

  useEffect(() => {
    if (!config.githubConnectorId) {
      setProjects([]);
      setProjectsError(null);
      return;
    }
    let cancelled = false;
    setProjectsError(null);
    machineClient
      .getGithubProjectsMetadata(config.githubConnectorId)
      .then((result) => {
        if (!cancelled) setProjects(result.projects);
      })
      .catch((error) => {
        if (cancelled) return;
        setProjects([]);
        setProjectsError(
          error instanceof Error
            ? error.message
            : 'Failed to load GitHub Projects.'
        );
      });
    return () => {
      cancelled = true;
    };
  }, [config.githubConnectorId, machineClient]);

  useEffect(() => {
    if (!vibeProjectId) {
      setVibeStatuses([]);
      return;
    }
    listProjectStatuses(vibeProjectId)
      .then(setVibeStatuses)
      .catch(() => setVibeStatuses([]));
  }, [vibeProjectId]);

  const update = (patch: Partial<GithubIssueSyncRuleConfig>) =>
    onChange({ ...config, ...patch });

  const updateMapping = (vibeStatusId: string, githubOptionId: string) => {
    const rest = config.statusMappings.filter(
      (mapping) => mapping.vibeStatusId !== vibeStatusId
    );
    update({
      statusMappings: githubOptionId
        ? [...rest, { vibeStatusId, githubOptionId }]
        : rest,
    });
  };

  return (
    <div className="space-y-4 rounded-sm border border-border p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SettingsField label="GitHub connector">
          <SettingsSelect
            value={config.githubConnectorId}
            options={githubConnectors.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onChange={(githubConnectorId) =>
              update({
                githubConnectorId,
                githubProjectId: '',
                githubStatusFieldId: '',
                statusMappings: [],
              })
            }
          />
        </SettingsField>
        <SettingsField label="Vibe connector">
          <SettingsSelect
            value={config.vibeConnectorId}
            options={vibeConnectors.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onChange={(vibeConnectorId) =>
              update({ vibeConnectorId, statusMappings: [] })
            }
          />
        </SettingsField>
      </div>
      <SettingsField label="GitHub Project">
        <div className="space-y-2">
          <SettingsSelect
            value={config.githubProjectId}
            options={[
              { value: '', label: 'Select a project' },
              ...projects.map((project) => ({
                value: project.id,
                label: project.title,
              })),
            ]}
            onChange={(githubProjectId) => {
              const project = projects.find(
                (item) => item.id === githubProjectId
              );
              const options = project?.statusField?.options ?? [];
              const statusMappings = vibeStatuses.flatMap((status) => {
                const option = options.find(
                  (item) =>
                    item.name.trim().toLowerCase() ===
                    status.name.trim().toLowerCase()
                );
                return option
                  ? [{ vibeStatusId: status.id, githubOptionId: option.id }]
                  : [];
              });
              update({
                githubProjectId,
                githubStatusFieldId: project?.statusField?.id ?? '',
                statusMappings,
              });
            }}
          />
          {projectsError && (
            <p className="text-sm text-error">
              Failed to load GitHub Projects: {projectsError}
            </p>
          )}
        </div>
      </SettingsField>
      <SettingsCheckbox
        id="github-sync-other-repositories"
        label="Include issues from other repositories"
        checked={config.includeIssuesFromOtherRepositories}
        onChange={(includeIssuesFromOtherRepositories) =>
          update({ includeIssuesFromOtherRepositories })
        }
      />
      <SettingsField label="Status mapping">
        <div className="space-y-2">
          {vibeStatuses.map((status) => (
            <div
              key={status.id}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3"
            >
              <span className="truncate text-sm text-normal">
                {status.name}
              </span>
              <SettingsSelect
                value={
                  config.statusMappings.find(
                    (mapping) => mapping.vibeStatusId === status.id
                  )?.githubOptionId ?? ''
                }
                options={[
                  { value: '', label: 'Do not sync' },
                  ...(selectedProject?.statusField?.options ?? [])
                    .filter(
                      (option) =>
                        !config.statusMappings.some(
                          (mapping) =>
                            mapping.githubOptionId === option.id &&
                            mapping.vibeStatusId !== status.id
                        )
                    )
                    .map((option) => ({
                      value: option.id,
                      label: option.name,
                    })),
                ]}
                onChange={(githubOptionId) =>
                  updateMapping(status.id, githubOptionId)
                }
              />
            </div>
          ))}
          {!vibeStatuses.length && (
            <p className="text-sm text-low">
              Select configured GitHub and Vibe connectors.
            </p>
          )}
        </div>
      </SettingsField>
      <SettingsField label="Synchronized fields">
        <div className="space-y-2">
          <SettingsCheckbox
            id="github-sync-title"
            label="Title"
            checked={config.fields.title}
            onChange={(title) =>
              update({ fields: { ...config.fields, title } })
            }
          />
          <SettingsCheckbox
            id="github-sync-description"
            label="Description"
            checked={config.fields.description}
            onChange={(description) =>
              update({ fields: { ...config.fields, description } })
            }
          />
          <SettingsCheckbox
            id="github-sync-status"
            label="Project status"
            checked={config.fields.status}
            onChange={(status) =>
              update({ fields: { ...config.fields, status } })
            }
          />
          <SettingsCheckbox
            id="github-sync-comments"
            label="Comments"
            checked={config.fields.comments}
            onChange={(comments) =>
              update({ fields: { ...config.fields, comments } })
            }
          />
        </div>
      </SettingsField>
    </div>
  );
}

function randomId(prefix: string) {
  return `${prefix}-${Math.random().toString(16).slice(2, 8)}`;
}

function defaultConnectorName(type: string) {
  switch (type) {
    case 'slack':
      return 'Slack channel polling';
    case 'github':
      return 'GitHub issue poller';
    case 'vibe_kanban':
      return 'Vibe Kanban issue creator';
    default:
      return type;
  }
}

export function AutomationSettingsSection() {
  const { t } = useTranslation('settings');
  const machineClient = useSettingsMachineClient();
  const { config, updateAndSaveConfig } = useUserSystem();

  const [state, setState] = useState<AutomationState | null>(null);
  const [logs, setLogs] = useState<AutomationLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [memoryConfig, setMemoryConfig] =
    useState<AgentMemorySyncConfig | null>(null);
  const [memoryStatus, setMemoryStatus] =
    useState<AgentMemorySyncStatus | null>(null);
  const [memoryLogs, setMemoryLogs] = useState<AgentMemorySyncLogEntry[]>([]);
  const [memoryMutations, setMemoryMutations] = useState<AgentMemoryMutation[]>(
    []
  );
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [mutationTarget, setMutationTarget] =
    useState<AgentMemoryMutation | null>(null);
  const [mutationOperation, setMutationOperation] =
    useState<AgentMemoryMutationOperation>('update');
  const [mutationScope, setMutationScope] =
    useState<AgentMemoryScope>('user_global');
  const [mutationScopeKey, setMutationScopeKey] = useState('');
  const [mutationMatchText, setMutationMatchText] = useState('');
  const [mutationReplacementText, setMutationReplacementText] = useState('');

  const [connector, setConnector] = useState<ConnectorDraft | null>(null);
  const [rule, setRule] = useState<RuleDraft | null>(null);
  const [routine, setRoutine] = useState<RoutineDraft | null>(null);

  const refreshLogs = useCallback(async () => {
    if (!machineClient) return;
    try {
      setLogs(await machineClient.getAutomationLogs());
    } catch {
      // Logs are best-effort; a load failure is already surfaced by the state load.
    }
  }, [machineClient]);

  const load = useCallback(async () => {
    if (!machineClient) return;
    setLoading(true);
    setError(null);
    try {
      setState(await machineClient.getAutomationState());
      await refreshLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [machineClient, refreshLogs]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (config?.agent_memory_sync) {
      setMemoryConfig(config.agent_memory_sync);
    }
  }, [config?.agent_memory_sync]);

  const refreshMemory = useCallback(async () => {
    if (!machineClient) return;
    const [nextStatus, nextLogs, nextMutations] = await Promise.all([
      machineClient.getAgentMemorySyncStatus(),
      machineClient.getAgentMemorySyncLogs(),
      machineClient.listAgentMemoryMutations(),
    ]);
    setMemoryStatus(nextStatus);
    setMemoryLogs(nextLogs);
    setMemoryMutations(nextMutations);
  }, [machineClient]);

  useEffect(() => {
    refreshMemory().catch((err) =>
      setError(err instanceof Error ? err.message : String(err))
    );
  }, [refreshMemory]);

  useEffect(() => {
    if (!memoryStatus?.running) return;
    const interval = window.setInterval(
      () => refreshMemory().catch(() => undefined),
      2000
    );
    return () => window.clearInterval(interval);
  }, [memoryStatus?.running, refreshMemory]);

  const saveMemoryConfig = async () => {
    if (!memoryConfig) return;
    const shouldCatchUp =
      memoryConfig.enabled && !config?.agent_memory_sync.enabled;
    setMemoryBusy(true);
    setError(null);
    try {
      const saved = await updateAndSaveConfig({
        agent_memory_sync: memoryConfig,
      });
      if (!saved) throw new Error('Failed to save memory sync settings');
      if (shouldCatchUp && machineClient) {
        await machineClient.runAgentMemorySync();
      }
      setNotice(
        shouldCatchUp
          ? t(
              'settings.automation.memory.optedIn',
              'Memory sync enabled. Catch-up started.'
            )
          : t('settings.automation.memory.saved', 'Memory sync settings saved.')
      );
      if (shouldCatchUp) {
        window.setTimeout(() => refreshMemory().catch(() => undefined), 1000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMemoryBusy(false);
    }
  };

  const runMemoryNow = async () => {
    if (!machineClient) return;
    setMemoryBusy(true);
    setError(null);
    try {
      await machineClient.runAgentMemorySync();
      setNotice(
        t('settings.automation.memory.started', 'Memory sync started.')
      );
      window.setTimeout(() => refreshMemory().catch(() => undefined), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMemoryBusy(false);
    }
  };

  const resetMutationForm = () => {
    setMutationTarget(null);
    setMutationOperation('update');
    setMutationScope('user_global');
    setMutationScopeKey('');
    setMutationMatchText('');
    setMutationReplacementText('');
  };

  const editMutation = (
    mutation: AgentMemoryMutation,
    operation: AgentMemoryMutationOperation
  ) => {
    setMutationTarget(mutation);
    setMutationOperation(operation);
    setMutationScope(mutation.scope);
    setMutationScopeKey(mutation.scope_key ?? '');
    setMutationMatchText(mutation.replacement_text ?? mutation.match_text);
    setMutationReplacementText('');
  };

  const submitMutation = async () => {
    if (!machineClient || !mutationMatchText.trim()) return;
    if (mutationOperation === 'update' && !mutationReplacementText.trim()) {
      setError('Replacement memory is required for an update.');
      return;
    }
    if (mutationScope === 'repository' && !mutationScopeKey.trim()) {
      setError('Repository scope requires a canonical repository key.');
      return;
    }
    setMemoryBusy(true);
    setError(null);
    try {
      await machineClient.createAgentMemoryMutation({
        memory_id: mutationTarget?.memory_id ?? null,
        expected_generation: mutationTarget?.generation ?? null,
        operation: mutationOperation,
        scope: mutationScope,
        scope_key:
          mutationScope === 'repository' ? mutationScopeKey.trim() : null,
        match_text: mutationMatchText.trim(),
        replacement_text:
          mutationOperation === 'update'
            ? mutationReplacementText.trim()
            : null,
      });
      resetMutationForm();
      await refreshMemory();
      setNotice(
        mutationOperation === 'delete'
          ? 'Memory deletion guard created.'
          : 'Memory update guard created.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMemoryBusy(false);
    }
  };

  // Run a mutating worker call: clear banners, apply returned state, show a notice.
  const run = useCallback(
    async (fn: () => Promise<AutomationState | void>, ok?: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const next = await fn();
        if (next) setState(next);
        if (ok) setNotice(ok);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  if (!machineClient) {
    return (
      <div className="rounded-sm border border-warning/50 bg-warning/10 p-4 text-sm text-warning">
        {t(
          'settings.automation.noHost',
          'Select a machine to configure its automation worker.'
        )}
      </div>
    );
  }

  // ----- master switch -----
  const toggleMaster = (enabled: boolean) =>
    run(() => machineClient.setAutomationEnabled(enabled));

  // ----- connectors -----
  const editConnector = (c: AutomationConnector) =>
    setConnector({
      id: c.id,
      name: c.name,
      type: c.type,
      enabled: c.enabled,
      configText: JSON.stringify(c.config ?? {}, null, 2),
      isNew: false,
    });

  const addConnector = (type: AutomationConnectorType) =>
    setConnector({
      id: randomId(type),
      name: defaultConnectorName(type),
      type,
      enabled: false,
      configText: JSON.stringify(AUTOMATION_CONNECTOR_DEFAULTS[type], null, 2),
      isNew: true,
    });

  const saveConnector = () => {
    if (!connector) return;
    let config: Record<string, unknown>;
    try {
      config = connector.configText.trim()
        ? JSON.parse(connector.configText)
        : {};
    } catch {
      setError(
        t('settings.automation.errors.invalidJson', 'Config is not valid JSON.')
      );
      return;
    }
    run(
      async () => {
        const next = await machineClient.saveAutomationConnector({
          id: connector.id.trim(),
          name: connector.name.trim() || connector.id.trim(),
          type: connector.type,
          enabled: connector.enabled,
          config,
        });
        setConnector(null);
        return next;
      },
      t('settings.automation.notices.connectorSaved', 'Connector saved.')
    );
  };

  const deleteConnector = (id: string) =>
    run(async () => {
      const next = await machineClient.deleteAutomationConnector(id);
      setConnector((cur) => (cur?.id === id ? null : cur));
      return next;
    });

  const pollConnector = (id: string) =>
    run(
      async () => {
        await machineClient.pollAutomationConnector(id);
        await refreshLogs();
      },
      t('settings.automation.notices.polled', 'Poll triggered.')
    );

  // ----- rules -----
  const editRule = (r: AutomationRule) =>
    setRule({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      kind: r.kind ?? 'script',
      config: (r.config ?? {}) as Record<string, unknown>,
      script: r.script,
      isNew: false,
    });

  const addRule = () =>
    setRule({
      id: randomId('rule'),
      name: t('settings.automation.untitledRule', 'Untitled rule'),
      enabled: true,
      kind: 'script',
      config: {},
      script:
        'async function handle(event, ctx) {\n  ctx.log("info", "event received", { event });\n}',
      isNew: true,
    });

  const saveRule = () => {
    if (!rule) return;
    run(
      async () => {
        const next = await machineClient.saveAutomationRule({
          id: rule.id.trim(),
          name: rule.name.trim() || rule.id.trim(),
          enabled: rule.enabled,
          kind: rule.kind,
          config: rule.config,
          script: rule.script,
        });
        setRule(null);
        return next;
      },
      t('settings.automation.notices.ruleSaved', 'Rule saved.')
    );
  };

  const deleteRule = (id: string) =>
    run(async () => {
      const next = await machineClient.deleteAutomationRule(id);
      setRule((cur) => (cur?.id === id ? null : cur));
      return next;
    });

  const editRoutine = (item: AutomationRoutine) =>
    setRoutine({
      id: item.id,
      name: item.name,
      enabled: item.enabled,
      definitionText: JSON.stringify(
        {
          trigger: item.trigger,
          condition: item.condition,
          action: item.action,
        },
        null,
        2
      ),
      isNew: false,
    });

  const addRoutine = () =>
    setRoutine({
      id: randomId('routine'),
      name: 'Untitled routine',
      enabled: false,
      definitionText: JSON.stringify(
        {
          trigger: {
            type: 'schedule',
            cron: '0 9 * * 1-5',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          condition: null,
          action: {
            type: 'notification',
            connectorId: 'vibe-default',
            targetHostId: '',
            input: { title: '', message: '' },
          },
        },
        null,
        2
      ),
      isNew: true,
    });

  const saveRoutine = () => {
    if (!routine) return;
    let definition: Pick<AutomationRoutine, 'trigger' | 'condition' | 'action'>;
    try {
      definition = JSON.parse(routine.definitionText);
    } catch {
      setError(
        t('settings.automation.errors.invalidJson', 'Config is not valid JSON.')
      );
      return;
    }
    run(async () => {
      const next = await machineClient.saveAutomationRoutine({
        id: routine.id,
        name: routine.name,
        enabled: routine.enabled,
        ...definition,
      });
      setRoutine(null);
      return next;
    }, 'Routine saved.');
  };

  const deleteRoutine = (id: string) =>
    run(async () => {
      const next = await machineClient.deleteAutomationRoutine(id);
      setRoutine(null);
      return next;
    });

  const runRoutineNow = (id: string) =>
    run(async () => {
      await machineClient.runAutomationRoutine(id);
      return machineClient.getAutomationState();
    }, 'Routine started.');

  const masterOn = state?.enabled !== false;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-sm border border-error/50 bg-error/10 p-4 text-sm text-error">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-sm border border-success/50 bg-success/10 p-4 text-sm text-success">
          {notice}
        </div>
      )}

      {/* Master switch */}
      <SettingsCard
        title={t('settings.automation.title', 'Automation Worker')}
        description={t(
          'settings.automation.description',
          'Poll Slack/GitHub and turn matching events into Vibe Kanban issues via editable rules. The worker runs alongside this machine.'
        )}
      >
        <SettingsCheckbox
          id="automation-master"
          label={t(
            'settings.automation.enableLabel',
            'Enable automation worker'
          )}
          description={t(
            'settings.automation.enableHelper',
            'When off, the worker stays running but stops polling and running rules.'
          )}
          checked={masterOn}
          onChange={toggleMaster}
          disabled={busy || loading || !state}
        />
        {loading && (
          <p className="text-sm text-low">
            {t('settings.automation.loading', 'Loading worker state…')}
          </p>
        )}
      </SettingsCard>

      <SettingsCard
        title={t(
          'settings.automation.memory.mutationsTitle',
          'Memory corrections and deletions'
        )}
        description={t(
          'settings.automation.memory.mutationsDescription',
          'Create generation-checked update or deletion guards. Guards remain active so stale computers cannot restore old memory.'
        )}
      >
        <div className="space-y-3 rounded-sm border border-border p-4">
          {mutationTarget && (
            <p className="text-xs text-low">
              Editing memory {mutationTarget.memory_id}, generation{' '}
              {String(mutationTarget.generation)}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SettingsField label="Operation">
              <SettingsSelect
                value={mutationOperation}
                options={[
                  { value: 'update', label: 'Update memory' },
                  { value: 'delete', label: 'Delete memory' },
                ]}
                onChange={(value) =>
                  setMutationOperation(value as AgentMemoryMutationOperation)
                }
              />
            </SettingsField>
            <SettingsField label="Scope">
              <SettingsSelect
                value={mutationScope}
                options={[
                  { value: 'user_global', label: 'All repositories' },
                  { value: 'repository', label: 'One repository' },
                ]}
                onChange={(value) =>
                  setMutationScope(value as AgentMemoryScope)
                }
                disabled={mutationTarget != null}
              />
            </SettingsField>
          </div>
          {mutationScope === 'repository' && (
            <SettingsField
              label="Canonical repository key"
              description="For example: github.com/owner/repository"
            >
              <SettingsInput
                value={mutationScopeKey}
                onChange={setMutationScopeKey}
                disabled={mutationTarget != null}
              />
            </SettingsField>
          )}
          <SettingsField
            label="Existing memory to replace or remove"
            description="Use the exact distinctive text exported by the agent."
          >
            <SettingsTextarea
              value={mutationMatchText}
              onChange={setMutationMatchText}
              rows={4}
            />
          </SettingsField>
          {mutationOperation === 'update' && (
            <SettingsField label="Replacement memory">
              <SettingsTextarea
                value={mutationReplacementText}
                onChange={setMutationReplacementText}
                rows={4}
              />
            </SettingsField>
          )}
          <div className="flex gap-2">
            <PrimaryButton
              value={
                mutationOperation === 'delete'
                  ? 'Create deletion guard'
                  : 'Create update guard'
              }
              onClick={submitMutation}
              disabled={memoryBusy || !mutationMatchText.trim()}
              actionIcon={memoryBusy ? 'spinner' : undefined}
            />
            {mutationTarget && (
              <PrimaryButton
                variant="tertiary"
                value="Cancel"
                onClick={resetMutationForm}
                disabled={memoryBusy}
              />
            )}
          </div>
        </div>

        {memoryMutations.length === 0 ? (
          <p className="text-sm text-low">No memory guards yet.</p>
        ) : (
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {memoryMutations.map((mutation) => (
              <div
                key={mutation.id}
                className="space-y-2 rounded-sm border border-border/60 bg-secondary/30 p-3 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold uppercase">
                    {mutation.operation}
                  </span>
                  <span>generation {String(mutation.generation)}</span>
                  <span>{mutation.scope}</span>
                  <span>{String(mutation.receipt_count)} agent receipt(s)</span>
                </div>
                <div className="whitespace-pre-wrap text-normal">
                  {mutation.match_text}
                </div>
                {mutation.replacement_text && (
                  <div className="whitespace-pre-wrap text-success">
                    → {mutation.replacement_text}
                  </div>
                )}
                <div className="flex gap-2">
                  {mutation.operation !== 'delete' && (
                    <PrimaryButton
                      variant="secondary"
                      value="Update again"
                      onClick={() => editMutation(mutation, 'update')}
                      disabled={memoryBusy}
                    />
                  )}
                  <PrimaryButton
                    variant="tertiary"
                    value="Delete"
                    onClick={() => editMutation(mutation, 'delete')}
                    disabled={memoryBusy || mutation.operation === 'delete'}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title={t('settings.automation.memory.title', 'Agent Memory Sync')}
        description={t(
          'settings.automation.memory.description',
          'Let installed agents reconcile repository memories across your computers once a day.'
        )}
        headerAction={
          <PrimaryButton
            variant="secondary"
            value={t(
              'settings.automation.memory.runNow',
              'Sync all online computers'
            )}
            onClick={runMemoryNow}
            disabled={memoryBusy || memoryStatus?.running}
            actionIcon={memoryStatus?.running ? 'spinner' : undefined}
          />
        }
      >
        <SettingsCheckbox
          id="agent-memory-sync-enabled"
          label={t(
            'settings.automation.memory.enabled',
            'Enable daily memory reconciliation'
          )}
          description={t(
            'settings.automation.memory.enabledHelper',
            'Agents update their own native memory; Vibe Kanban stores only shareable snapshots and operational logs.'
          )}
          checked={memoryConfig?.enabled ?? false}
          onChange={(enabled) =>
            setMemoryConfig((current) => ({
              enabled,
              daily_local_time: current?.daily_local_time ?? '03:00',
              agents: current?.agents ?? ['claude_code', 'codex'],
            }))
          }
        />
        <SettingsField
          label={t('settings.automation.memory.time', 'Daily local time')}
          description={t(
            'settings.automation.memory.timeHelper',
            'A missed run starts after this computer comes back online.'
          )}
        >
          <input
            type="time"
            value={memoryConfig?.daily_local_time ?? '03:00'}
            disabled={!memoryConfig?.enabled}
            onChange={(event) =>
              setMemoryConfig((current) => ({
                enabled: current?.enabled ?? false,
                daily_local_time: event.target.value,
                agents: current?.agents ?? ['claude_code', 'codex'],
              }))
            }
            className="w-full bg-secondary border border-border rounded-sm px-base py-half text-sm text-high disabled:opacity-50"
          />
        </SettingsField>
        <div className="grid grid-cols-2 gap-2">
          {[
            ['claude_code', 'Claude Code'],
            ['codex', 'Codex'],
          ].map(([agent, label]) => {
            const selected = memoryConfig?.agents ?? [];
            return (
              <SettingsCheckbox
                key={agent}
                id={`agent-memory-sync-${agent}`}
                label={label}
                checked={selected.includes(agent as AgentMemoryKind)}
                disabled={!memoryConfig?.enabled}
                onChange={(checked) =>
                  setMemoryConfig((current) => ({
                    enabled: current?.enabled ?? false,
                    daily_local_time: current?.daily_local_time ?? '03:00',
                    agents: checked
                      ? [...selected, agent as AgentMemoryKind]
                      : selected.filter((item) => item !== agent),
                  }))
                }
              />
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-low">
            <p>
              {memoryStatus?.last_status
                ? `${memoryStatus.last_status} · ${memoryStatus.last_finished_at ?? memoryStatus.last_started_at ?? ''}`
                : t('settings.automation.memory.neverRun', 'Not run yet')}
            </p>
            {memoryStatus?.central_session && (
              <p>
                {`Central session ${memoryStatus.central_session.status} · round ${memoryStatus.central_session.round}/${memoryStatus.central_session.max_rounds} · ${memoryStatus.central_session.completed_count}/${memoryStatus.central_session.target_count} hosts`}
              </p>
            )}
            {memoryStatus?.central_targets.map((target) => (
              <p key={target.host_id}>
                {`${target.host_name}: ${target.status} · round ${target.round} · attempts ${target.attempts}${target.retry_at ? ` · retry ${new Date(target.retry_at).toLocaleString()}` : ''}${target.error ? ` · ${target.error}` : ''}`}
              </p>
            ))}
          </div>
          <PrimaryButton
            value={t('settings.automation.memory.save', 'Save schedule')}
            onClick={saveMemoryConfig}
            disabled={!memoryConfig || memoryBusy}
            actionIcon={memoryBusy ? 'spinner' : undefined}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title={t(
          'settings.automation.memory.logsTitle',
          'Memory sync activity'
        )}
        description={t(
          'settings.automation.memory.logsDescription',
          'Operational events by run, repository, and agent. Memory contents are never included.'
        )}
        headerAction={
          <PrimaryButton
            variant="secondary"
            value={t('settings.automation.logs.refresh', 'Refresh')}
            onClick={() => refreshMemory()}
            disabled={memoryBusy}
          />
        }
      >
        {memoryLogs.length === 0 ? (
          <p className="text-sm text-low">
            {t('settings.automation.memory.noLogs', 'No memory sync logs yet.')}
          </p>
        ) : (
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {memoryLogs.map((log) => (
              <div
                key={log.id}
                className="rounded-sm border border-border/60 bg-secondary/30 p-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'font-semibold uppercase',
                      log.level === 'error' && 'text-error',
                      log.level === 'warn' && 'text-warning',
                      log.level === 'info' && 'text-low'
                    )}
                  >
                    {log.level}
                  </span>
                  <span className="text-low">
                    {new Date(log.created_at).toLocaleString(
                      undefined,
                      withDisplayTimeZone()
                    )}
                  </span>
                  <span className="rounded bg-secondary px-half text-low">
                    {log.trigger_kind}
                  </span>
                  {log.agent_kind && <span>{log.agent_kind}</span>}
                  {log.repo_name && <span>{log.repo_name}</span>}
                </div>
                <div className="text-normal">{log.message}</div>
                <div className="text-low">
                  {log.phase} · {log.run_id}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      {/* Connectors */}
      <SettingsCard
        title={t('settings.automation.connectors.title', 'Connectors')}
        description={t(
          'settings.automation.connectors.description',
          'Sources the worker polls and the Vibe Kanban target. Secrets are stored on the worker and shown masked.'
        )}
      >
        <div className="flex flex-wrap gap-2">
          {CONNECTOR_TYPES.map((type) => (
            <PrimaryButton
              key={type}
              variant="secondary"
              value={t(
                `settings.automation.connectors.add.${type}`,
                `Add ${type}`
              )}
              onClick={() => addConnector(type)}
              disabled={busy}
            />
          ))}
        </div>

        <ItemList
          items={state?.connectors ?? []}
          selectedId={connector?.id ?? null}
          getKey={(c) => c.id}
          isEnabled={(c) => c.enabled}
          onSelect={editConnector}
          render={(c) => (
            <>
              <span className="font-medium text-normal truncate">{c.name}</span>
              <span className="text-xs px-half rounded bg-secondary text-low shrink-0">
                {c.type}
              </span>
            </>
          )}
          emptyText={t(
            'settings.automation.connectors.empty',
            'No connectors yet.'
          )}
        />

        {connector && (
          <div className="space-y-4 rounded-sm border border-border p-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SettingsField label={t('settings.automation.fields.id', 'ID')}>
                <SettingsInput
                  value={connector.id}
                  onChange={(v) => setConnector({ ...connector, id: v })}
                  disabled={!connector.isNew}
                />
              </SettingsField>
              <SettingsField
                label={t('settings.automation.fields.name', 'Name')}
              >
                <SettingsInput
                  value={connector.name}
                  onChange={(v) => setConnector({ ...connector, name: v })}
                />
              </SettingsField>
            </div>
            {connector.isNew && (
              <SettingsField
                label={t('settings.automation.fields.type', 'Type')}
              >
                <SettingsSelect
                  value={connector.type}
                  options={CONNECTOR_TYPES.map((type) => ({
                    value: type,
                    label: type,
                  }))}
                  onChange={(type) =>
                    setConnector({
                      ...connector,
                      type,
                      configText: JSON.stringify(
                        AUTOMATION_CONNECTOR_DEFAULTS[
                          type as AutomationConnectorType
                        ] ?? {},
                        null,
                        2
                      ),
                    })
                  }
                />
              </SettingsField>
            )}
            <SettingsCheckbox
              id="automation-connector-enabled"
              label={t('settings.automation.fields.enabled', 'Enabled')}
              checked={connector.enabled}
              onChange={(v) => setConnector({ ...connector, enabled: v })}
            />
            <SettingsField
              label={t('settings.automation.fields.config', 'Config (JSON)')}
            >
              <SettingsTextarea
                value={connector.configText}
                onChange={(v) => setConnector({ ...connector, configText: v })}
                rows={12}
                monospace
              />
            </SettingsField>
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                value={t('settings.automation.actions.save', 'Save')}
                onClick={saveConnector}
                disabled={busy}
                actionIcon={busy ? 'spinner' : undefined}
              />
              {!connector.isNew && (
                <PrimaryButton
                  variant="secondary"
                  value={t('settings.automation.actions.poll', 'Poll now')}
                  onClick={() => pollConnector(connector.id)}
                  disabled={busy}
                />
              )}
              <PrimaryButton
                variant="tertiary"
                value={t('settings.automation.actions.cancel', 'Cancel')}
                onClick={() => setConnector(null)}
                disabled={busy}
              />
              {!connector.isNew && (
                <PrimaryButton
                  variant="tertiary"
                  value={t('settings.automation.actions.delete', 'Delete')}
                  onClick={() => deleteConnector(connector.id)}
                  disabled={busy}
                />
              )}
            </div>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="Routines"
        description="Bind a schedule or Vibe event to one typed action. Definitions are JSON; scripts remain in Rules."
        headerAction={
          <PrimaryButton
            variant="secondary"
            value="Add routine"
            onClick={addRoutine}
            disabled={busy}
          />
        }
      >
        <ItemList
          items={state?.routines ?? []}
          selectedId={routine?.id ?? null}
          getKey={(item) => item.id}
          isEnabled={(item) => item.enabled}
          onSelect={editRoutine}
          render={(item) => (
            <span className="font-medium text-normal truncate">
              {item.name} · {item.trigger.type} → {item.action.type}
            </span>
          )}
          emptyText="No routines yet."
        />
        {routine && (
          <div className="space-y-4 rounded-sm border border-border p-4">
            <SettingsField label="Name">
              <SettingsInput
                value={routine.name}
                onChange={(name) => setRoutine({ ...routine, name })}
              />
            </SettingsField>
            <SettingsCheckbox
              id="automation-routine-enabled"
              label="Enabled"
              checked={routine.enabled}
              onChange={(enabled) => setRoutine({ ...routine, enabled })}
            />
            <SettingsField label="Trigger / condition / action (JSON)">
              <SettingsTextarea
                value={routine.definitionText}
                onChange={(definitionText) =>
                  setRoutine({ ...routine, definitionText })
                }
                rows={14}
                monospace
              />
            </SettingsField>
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                value="Save"
                onClick={saveRoutine}
                disabled={busy}
              />
              {!routine.isNew && (
                <PrimaryButton
                  variant="secondary"
                  value="Run now"
                  onClick={() => runRoutineNow(routine.id)}
                  disabled={busy}
                />
              )}
              <PrimaryButton
                variant="tertiary"
                value="Cancel"
                onClick={() => setRoutine(null)}
                disabled={busy}
              />
              {!routine.isNew && (
                <PrimaryButton
                  variant="tertiary"
                  value="Delete"
                  onClick={() => deleteRoutine(routine.id)}
                  disabled={busy}
                />
              )}
            </div>
          </div>
        )}
        {!!state?.routineRuns?.length && (
          <div className="mt-4 space-y-2">
            {state.routineRuns.slice(0, 10).map((item) => (
              <div
                key={item.id}
                className="rounded-sm border border-border p-3 text-xs"
              >
                {item.routineId} · {item.status} ·{' '}
                {new Date(item.startedAt).toLocaleString()}
                {item.targetHostId ? ` · ${item.targetHostId}` : ''}
                {` · ${item.attempts}/${item.maxAttempts}`}
                {item.error ? ` · ${item.error}` : ''}
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      {/* Rules */}
      <SettingsCard
        title={t('settings.automation.rules.title', 'Rules')}
        description={t(
          'settings.automation.rules.description',
          'JavaScript handlers that turn polled events into issues. Trusted code — only edit rules you understand.'
        )}
        headerAction={
          <PrimaryButton
            variant="secondary"
            value={t('settings.automation.rules.add', 'Add rule')}
            onClick={addRule}
            disabled={busy}
          />
        }
      >
        <ItemList
          items={state?.rules ?? []}
          selectedId={rule?.id ?? null}
          getKey={(r) => r.id}
          isEnabled={(r) => r.enabled}
          onSelect={editRule}
          render={(r) => (
            <span className="font-medium text-normal truncate">{r.name}</span>
          )}
          emptyText={t('settings.automation.rules.empty', 'No rules yet.')}
        />

        {rule && (
          <div className="space-y-4 rounded-sm border border-border p-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SettingsField label={t('settings.automation.fields.id', 'ID')}>
                <SettingsInput
                  value={rule.id}
                  onChange={(v) => setRule({ ...rule, id: v })}
                  disabled={!rule.isNew}
                />
              </SettingsField>
              <SettingsField
                label={t('settings.automation.fields.name', 'Name')}
              >
                <SettingsInput
                  value={rule.name}
                  onChange={(v) => setRule({ ...rule, name: v })}
                />
              </SettingsField>
            </div>
            <SettingsCheckbox
              id="automation-rule-enabled"
              label={t('settings.automation.fields.enabled', 'Enabled')}
              checked={rule.enabled}
              onChange={(v) => setRule({ ...rule, enabled: v })}
            />
            {rule.kind === 'github_issue_sync' ? (
              <GithubIssueSyncRuleEditor
                machineClient={machineClient}
                connectors={state?.connectors ?? []}
                value={rule.config}
                onChange={(config) => setRule({ ...rule, config })}
              />
            ) : (
              <SettingsField
                label={t('settings.automation.fields.script', 'Rule script')}
              >
                <SettingsTextarea
                  value={rule.script}
                  onChange={(v) => setRule({ ...rule, script: v })}
                  rows={16}
                  monospace
                />
              </SettingsField>
            )}
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                value={t('settings.automation.actions.save', 'Save')}
                onClick={saveRule}
                disabled={busy}
                actionIcon={busy ? 'spinner' : undefined}
              />
              <PrimaryButton
                variant="tertiary"
                value={t('settings.automation.actions.cancel', 'Cancel')}
                onClick={() => setRule(null)}
                disabled={busy}
              />
              {!rule.isNew && (
                <PrimaryButton
                  variant="tertiary"
                  value={t('settings.automation.actions.delete', 'Delete')}
                  onClick={() => deleteRule(rule.id)}
                  disabled={busy}
                />
              )}
            </div>
          </div>
        )}
      </SettingsCard>

      {/* Logs */}
      <SettingsCard
        title={t('settings.automation.logs.title', 'Recent activity')}
        description={t(
          'settings.automation.logs.description',
          'Latest worker log entries.'
        )}
        headerAction={
          <PrimaryButton
            variant="secondary"
            value={t('settings.automation.logs.refresh', 'Refresh')}
            onClick={refreshLogs}
            disabled={busy}
          />
        }
      >
        {logs.length === 0 ? (
          <p className="text-sm text-low">
            {t('settings.automation.logs.empty', 'No log entries.')}
          </p>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {logs.slice(0, 50).map((log) => (
              <div
                key={log.id}
                className="rounded-sm border border-border/60 bg-secondary/30 p-2 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'font-semibold uppercase',
                      log.level === 'error' && 'text-error',
                      log.level === 'warn' && 'text-warning',
                      log.level === 'info' && 'text-low'
                    )}
                  >
                    {log.level}
                  </span>
                  <span className="text-low">
                    {new Date(log.ts).toLocaleString(
                      undefined,
                      withDisplayTimeZone()
                    )}
                  </span>
                </div>
                <div className="text-normal">{log.message}</div>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

// A compact selectable list of connectors/rules with an enabled/disabled dot.
function ItemList<T>({
  items,
  selectedId,
  getKey,
  isEnabled,
  onSelect,
  render,
  emptyText,
}: {
  items: T[];
  selectedId: string | null;
  getKey: (item: T) => string;
  isEnabled: (item: T) => boolean;
  onSelect: (item: T) => void;
  render: (item: T) => React.ReactNode;
  emptyText: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-low">{emptyText}</p>;
  }
  return (
    <div className="divide-y divide-border rounded-sm border border-border">
      {items.map((item) => {
        const key = getKey(item);
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(item)}
            className={cn(
              'flex w-full items-center gap-2 px-base py-half text-left transition-colors',
              'hover:bg-secondary',
              key === selectedId && 'bg-brand/10'
            )}
          >
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                isEnabled(item) ? 'bg-success' : 'bg-low/40'
              )}
            />
            {render(item)}
          </button>
        );
      })}
    </div>
  );
}
