import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentMemoryKind,
  AgentMemorySyncConfig,
  AgentMemorySyncLogEntry,
  AgentMemorySyncStatus,
} from 'shared/types';
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
  type AutomationState,
} from '@/shared/lib/automationWorker';

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
  script: string;
  isNew: boolean;
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
  const [memoryBusy, setMemoryBusy] = useState(false);

  const [connector, setConnector] = useState<ConnectorDraft | null>(null);
  const [rule, setRule] = useState<RuleDraft | null>(null);

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
    const [nextStatus, nextLogs] = await Promise.all([
      machineClient.getAgentMemorySyncStatus(),
      machineClient.getAgentMemorySyncLogs(),
    ]);
    setMemoryStatus(nextStatus);
    setMemoryLogs(nextLogs);
  }, [machineClient]);

  useEffect(() => {
    refreshMemory().catch((err) =>
      setError(err instanceof Error ? err.message : String(err))
    );
  }, [refreshMemory]);

  const saveMemoryConfig = async () => {
    if (!memoryConfig) return;
    setMemoryBusy(true);
    setError(null);
    try {
      const saved = await updateAndSaveConfig({
        agent_memory_sync: memoryConfig,
      });
      if (!saved) throw new Error('Failed to save memory sync settings');
      setNotice(
        t('settings.automation.memory.saved', 'Memory sync settings saved.')
      );
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
      script: r.script,
      isNew: false,
    });

  const addRule = () =>
    setRule({
      id: randomId('rule'),
      name: t('settings.automation.untitledRule', 'Untitled rule'),
      enabled: true,
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
        title={t('settings.automation.memory.title', 'Agent Memory Sync')}
        description={t(
          'settings.automation.memory.description',
          'Let installed agents reconcile repository memories across your computers once a day.'
        )}
        headerAction={
          <PrimaryButton
            variant="secondary"
            value={t('settings.automation.memory.runNow', 'Run now')}
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
          <p className="text-xs text-low">
            {memoryStatus?.last_status
              ? `${memoryStatus.last_status} · ${memoryStatus.last_finished_at ?? memoryStatus.last_started_at ?? ''}`
              : t('settings.automation.memory.neverRun', 'Not run yet')}
          </p>
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
