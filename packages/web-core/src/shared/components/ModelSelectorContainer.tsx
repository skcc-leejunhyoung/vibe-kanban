import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckIcon,
  FastForwardIcon,
  GearIcon,
  HandIcon,
  LightningIcon,
  ListBulletsIcon,
  SlidersHorizontalIcon,
  type Icon,
} from '@phosphor-icons/react';
import type { BaseCodingAgent, ExecutorConfig, ModelInfo } from 'shared/types';
import { PermissionPolicy } from 'shared/types';
import { toPrettyCase } from '@/shared/lib/string';
import {
  getModelKey,
  getRecentModelEntries,
  getRecentReasoningByModel,
  touchRecentModel,
  updateRecentModelEntries,
  setRecentReasoning,
} from '@/shared/lib/recentModels';
import {
  getReasoningLabel,
  getSelectedModel,
  escapeAttributeValue,
  parseModelId,
  appendPresetModel,
  resolveDefaultModelId,
  isModelAvailable,
  resolveDefaultReasoningId,
  splitFastSuffix,
  normalizeFastModelId,
  FAST_SUFFIX,
} from '@/shared/lib/modelSelector';
import { useHiddenModels } from '@/shared/stores/useUiPreferencesStore';
import { isLegacyUnversionedRevision, profilesApi } from '@/shared/lib/api';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { getResolvedTheme, useTheme } from '@/shared/hooks/useTheme';
import { useModelSelectorConfig } from '@/shared/hooks/useExecutorDiscovery';
import { ModelSelectorPopover } from '@vibe/ui/components/ModelSelectorPopover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTriggerButton,
} from '@vibe/ui/components/Dropdown';

interface ModelSelectorContainerProps {
  agent: BaseCodingAgent | null;
  workspaceId: string | undefined;
  sessionId?: string;
  /** Route model discovery to this host (remote runtime, host-picker flows). */
  hostId?: string | null;
  onAdvancedSettings?: () => void;
  presets: string[];
  selectedPreset: string | null;
  onPresetSelect?: (presetId: string | null) => void;
  onOverrideChange: (partial: Partial<ExecutorConfig>) => void;
  executorConfig: ExecutorConfig | null;
  presetOptions: ExecutorConfig | null | undefined;
  /** Show the preset (variant) dropdown. Hidden in Settings, where the variant
   * is already chosen by the surrounding picker. */
  showPreset?: boolean;
  /** Show the permission-policy dropdown. Hidden in Settings, where the policy
   * maps to executor-specific fields edited via the raw JSON form. */
  showPermissions?: boolean;
  /** Persist the picked model/effort to the recently-used LRU. Disabled in
   * Settings, which owns its own save flow. */
  persistRecent?: boolean;
}

export function ModelSelectorContainer({
  agent,
  workspaceId,
  sessionId,
  hostId,
  onAdvancedSettings,
  presets,
  selectedPreset,
  onPresetSelect,
  onOverrideChange,
  executorConfig,
  presetOptions,
  showPreset = true,
  showPermissions = true,
  persistRecent = true,
}: ModelSelectorContainerProps) {
  const { t } = useTranslation('common');
  const { theme } = useTheme();
  const resolvedTheme = getResolvedTheme(theme);
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedProviderId, setExpandedProviderId] = useState('');
  const contextHostId = useHostId();
  const targetHostId = hostId === undefined ? contextHostId : hostId;
  const { profiles, profilesRevision, setProfiles, reloadSystem } =
    useUserSystem();
  const defaultLabel = t('modelSelector.default');
  const loadingLabel = t('states.loading');

  const permissionMetaByPolicy: Record<
    PermissionPolicy,
    { label: string; icon: Icon }
  > = {
    [PermissionPolicy.AUTO]: {
      label: t('modelSelector.permissionAuto'),
      icon: FastForwardIcon,
    },
    [PermissionPolicy.SUPERVISED]: {
      label: t('modelSelector.permissionAsk'),
      icon: HandIcon,
    },
    [PermissionPolicy.PLAN]: {
      label: t('modelSelector.permissionPlan'),
      icon: ListBulletsIcon,
    },
  };

  const resolvedPreset =
    selectedPreset ??
    (presets.includes('DEFAULT') ? 'DEFAULT' : (presets[0] ?? null));

  const {
    config: streamConfig,
    loadingModels,
    error: streamError,
  } = useModelSelectorConfig(agent, {
    workspaceId: sessionId ? workspaceId : undefined,
    sessionId,
    hostId,
  });

  useEffect(() => {
    if (streamError) {
      console.error('Failed to fetch model config', streamError);
    }
  }, [streamError]);

  const baseConfig = streamConfig;

  const { hiddenKeys, isHidden } = useHiddenModels(agent);

  // Fast support is a property of the real (streamed) models; build the lookup
  // from baseConfig so it's available before we fold the preset model in below.
  const supportsFastById = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const model of baseConfig?.models ?? []) {
      map.set(model.id.toLowerCase(), model.supports_fast);
    }
    return map;
  }, [baseConfig?.models]);
  const supportsFast = useCallback(
    (baseId: string) => supportsFastById.get(baseId.toLowerCase()) ?? false,
    [supportsFastById]
  );

  const hasProviders = (baseConfig?.providers.length ?? 0) > 0;

  // A `-fast` suffix is a fast-tier toggle, not a distinct model. Normalize the
  // preset model to its base id so the picker shows the real model (with its
  // reasoning options + fast toggle) rather than a phantom `…-fast` entry.
  const { modelId: presetModelNormalized, fast: presetFast } = useMemo(
    () =>
      normalizeFastModelId(presetOptions?.model_id, hasProviders, supportsFast),
    [presetOptions?.model_id, hasProviders, supportsFast]
  );

  const config = appendPresetModel(baseConfig, presetModelNormalized);

  const availableProviderIds = useMemo(
    () => config?.providers.map((item) => item.id) ?? [],
    [config?.providers]
  );
  const providerIdMap = useMemo(
    () => new Map(availableProviderIds.map((id) => [id.toLowerCase(), id])),
    [availableProviderIds]
  );
  const resolveProviderId = (value?: string | null) =>
    value ? (providerIdMap.get(value.toLowerCase()) ?? null) : null;

  const { providerId: configProviderId, modelId: configModelIdRaw } = useMemo(
    () => parseModelId(executorConfig?.model_id, hasProviders),
    [executorConfig?.model_id, hasProviders]
  );

  // A `-fast` suffix on the stored model id is a fast-tier toggle, not a
  // distinct model — strip it for selection/matching and track it separately.
  const { baseId: configModelId, fast: configFast } = useMemo(
    () => splitFastSuffix(configModelIdRaw, supportsFast),
    [configModelIdRaw, supportsFast]
  );

  const fallbackProviderId = availableProviderIds[0] ?? null;
  const resolvedConfigProviderId = resolveProviderId(configProviderId);

  const { providerId: presetProviderId, modelId: presetModelId } = useMemo(
    () => parseModelId(presetModelNormalized, hasProviders),
    [presetModelNormalized, hasProviders]
  );
  const resolvedPresetProviderId = resolveProviderId(presetProviderId);

  const hasDefaultModel = Boolean(config?.default_model);
  const selectedProviderId =
    resolvedConfigProviderId ??
    resolvedPresetProviderId ??
    (hasDefaultModel ? fallbackProviderId : null);

  const defaultModelId = config
    ? resolveDefaultModelId(
        config.models,
        selectedProviderId,
        config.default_model,
        hasProviders
      )
    : null;

  const presetModelMatchesProvider =
    !selectedProviderId ||
    !resolvedPresetProviderId ||
    resolvedPresetProviderId === selectedProviderId;
  const resolvedPresetModelId = presetModelMatchesProvider
    ? presetModelId
    : null;

  const selectedModelId = (() => {
    const candidate = configModelId ?? resolvedPresetModelId ?? defaultModelId;
    if (!candidate || !config || !selectedProviderId) return candidate;
    const hasMatch = isModelAvailable(config, selectedProviderId, candidate);
    return hasMatch
      ? candidate
      : resolveDefaultModelId(
          config.models,
          selectedProviderId,
          config.default_model,
          hasProviders
        );
  })();

  // Fast is on when the winning selected-model source (session override, then
  // preset) carried the `-fast` toggle; the default model never does.
  const fastEnabled =
    configModelId != null
      ? configFast
      : resolvedPresetModelId != null
        ? presetFast
        : false;

  const selectedModel = config
    ? getSelectedModel(config.models, selectedProviderId, selectedModelId)
    : null;

  // Config passed to the popover with user-hidden models filtered out. The
  // currently-selected model is always kept so the picker can show it.
  const displayConfig = useMemo(() => {
    if (!config || hiddenKeys.size === 0) return config;
    const selLower = selectedModelId?.toLowerCase() ?? null;
    const models = config.models.filter((model) => {
      if (selLower && model.id.toLowerCase() === selLower) return true;
      return !isHidden(getModelKey(model));
    });
    return { ...config, models };
  }, [config, hiddenKeys, isHidden, selectedModelId]);

  const recentReasoningByModel = getRecentReasoningByModel(profiles, agent);

  const presetReasoningId =
    resolvedPresetModelId && selectedModelId === resolvedPresetModelId
      ? (presetOptions?.reasoning_id ?? null)
      : null;

  const recentReasoningId = useMemo(() => {
    if (!selectedModel || !recentReasoningByModel) return null;
    const key = selectedModel.provider_id
      ? `${selectedModel.provider_id}/${selectedModel.id}`
      : selectedModel.id;
    const keyLower = key.toLowerCase();
    for (const [k, v] of Object.entries(recentReasoningByModel)) {
      if (k.toLowerCase() === keyLower) {
        if (selectedModel.reasoning_options.some((o) => o.id === v)) return v;
      }
    }
    return null;
  }, [selectedModel, recentReasoningByModel]);

  const selectedReasoningId =
    executorConfig?.reasoning_id ??
    presetReasoningId ??
    recentReasoningId ??
    resolveDefaultReasoningId(selectedModel?.reasoning_options ?? []);

  const defaultAgentId =
    config?.agents.find((entry) => entry.is_default)?.id ?? null;

  const selectedAgentId =
    executorConfig?.agent_id !== undefined
      ? executorConfig.agent_id
      : (presetOptions?.agent_id ?? defaultAgentId);

  const supportsPermissions = (config?.permissions.length ?? 0) > 0;

  const basePermissionPolicy = supportsPermissions
    ? (presetOptions?.permission_policy ?? config?.permissions[0] ?? null)
    : null;
  const permissionPolicy = supportsPermissions
    ? (executorConfig?.permission_policy ?? basePermissionPolicy)
    : null;

  // LRU persistence (on popover close)

  const recentModelEntries = getRecentModelEntries(profiles, agent);
  const pendingModelRef = useRef<ModelInfo | null>(null);
  const pendingReasoningRef = useRef<string | null>(null);

  const persistPendingSelections = useCallback(() => {
    if (!persistRecent) return;
    if (!profiles || !profilesRevision || !agent) return;
    if (!pendingModelRef.current && !pendingReasoningRef.current) return;

    let nextProfiles = profiles;

    const model = pendingModelRef.current;
    if (model) {
      pendingModelRef.current = null;
      const current = getRecentModelEntries(nextProfiles, agent);
      const nextEntries = touchRecentModel(current, model);
      nextProfiles = updateRecentModelEntries(nextProfiles, agent, nextEntries);
    }

    const reasoningModel =
      model ??
      (selectedModelId && config
        ? getSelectedModel(config.models, selectedProviderId, selectedModelId)
        : null);
    if (pendingReasoningRef.current && reasoningModel) {
      nextProfiles = setRecentReasoning(
        nextProfiles,
        agent,
        reasoningModel,
        pendingReasoningRef.current
      );
      pendingReasoningRef.current = null;
    }

    if (nextProfiles !== profiles) {
      setProfiles(nextProfiles);
      const recent = nextProfiles[agent]?.recently_used_models;
      if (!recent) return;
      const saveRecentModels = isLegacyUnversionedRevision(profilesRevision)
        ? profilesApi
            .save(
              JSON.stringify({ executors: nextProfiles }, null, 2),
              profilesRevision,
              targetHostId
            )
            .then(() => ({
              content: JSON.stringify({ executors: nextProfiles }),
              revision: profilesRevision,
            }))
        : profilesApi.updateRecentModels(
            agent,
            recent,
            profilesRevision,
            targetHostId
          );
      void saveRecentModels
        .then((saved) => {
          const parsed = JSON.parse(saved.content) as {
            executors: Record<string, import('shared/types').ExecutorProfile>;
          };
          setProfiles(parsed.executors, saved.revision);
        })
        .catch((error) => {
          console.error('Failed to save recent models', error);
          void reloadSystem();
        });
    }
  }, [
    agent,
    config,
    persistRecent,
    profiles,
    profilesRevision,
    reloadSystem,
    selectedModelId,
    selectedProviderId,
    setProfiles,
    targetHostId,
  ]);

  const handleModelSelect = (modelId: string | null, providerId?: string) => {
    const modelOverride = (() => {
      if (!modelId) return null;
      if (providerId) return `${providerId}/${modelId}`;
      return modelId;
    })();
    onOverrideChange({ model_id: modelOverride });

    pendingModelRef.current =
      modelId && config
        ? (() => {
            const selectedId = modelId.toLowerCase();
            if (!providerId) {
              return (
                config.models.find((m) => m.id.toLowerCase() === selectedId) ??
                null
              );
            }
            const provider = providerId.toLowerCase();
            return (
              config.models.find(
                (m) =>
                  m.id.toLowerCase() === selectedId &&
                  m.provider_id?.toLowerCase() === provider
              ) ?? null
            );
          })()
        : null;
    pendingReasoningRef.current = null;
  };

  const handleReasoningSelect = (reasoningId: string | null) => {
    onOverrideChange({ reasoning_id: reasoningId });
    pendingReasoningRef.current = reasoningId;
  };

  const handleAgentSelect = (id: string | null) => {
    onOverrideChange({ agent_id: id });
  };

  const handlePermissionPolicyChange = (policy: PermissionPolicy) => {
    if (!supportsPermissions) return;
    onOverrideChange({ permission_policy: policy });
  };

  const handleFastToggle = (next: boolean) => {
    if (!selectedModelId) return;
    const id = next ? `${selectedModelId}${FAST_SUFFIX}` : selectedModelId;
    const modelOverride = selectedProviderId
      ? `${selectedProviderId}/${id}`
      : id;
    onOverrideChange({ model_id: modelOverride });
  };

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSearchQuery('');
  }, [selectedProviderId]);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      return;
    }
    requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (!node) return;
      if (selectedModelId && config) {
        const selected = getSelectedModel(
          config.models,
          selectedProviderId,
          selectedModelId
        );
        if (selected) {
          const key = getModelKey(selected);
          const selector = `[data-model-key="${escapeAttributeValue(key)}"]`;
          const target = node.querySelector(selector);
          if (target instanceof HTMLElement) {
            target.scrollIntoView({ block: 'nearest' });
            return;
          }
        }
      }
      if (!selectedModelId) {
        node.scrollTop = node.scrollHeight;
      }
    });
  }, [config, isOpen, selectedModelId, selectedProviderId]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      const selected =
        selectedModelId && config
          ? getSelectedModel(config.models, selectedProviderId, selectedModelId)
          : null;
      setExpandedProviderId(selected?.provider_id ?? selectedProviderId ?? '');
    } else {
      persistPendingSelections();
    }
  };

  useEffect(() => {
    if (isOpen) return;
    persistPendingSelections();
  }, [isOpen, persistPendingSelections]);

  const presetLabel = resolvedPreset
    ? toPrettyCase(resolvedPreset)
    : defaultLabel;

  if (!config) {
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTriggerButton size="sm" label={loadingLabel} disabled />
        </DropdownMenu>
      </>
    );
  }

  const showModelSelector = loadingModels || config.models.length > 0;
  const showDefaultOption = !config.default_model && config.models.length > 0;
  const displaySelectedModel = showModelSelector
    ? getSelectedModel(config.models, selectedProviderId, selectedModelId)
    : null;
  const reasoningLabel = displaySelectedModel
    ? getReasoningLabel(
        displaySelectedModel.reasoning_options,
        selectedReasoningId
      )
    : null;
  const modelLabelBase = loadingModels
    ? loadingLabel
    : (displaySelectedModel?.name ?? selectedModelId ?? defaultLabel);
  const modelLabel = reasoningLabel
    ? `${modelLabelBase} · ${reasoningLabel}`
    : modelLabelBase;

  const agentLabel = selectedAgentId
    ? (config.agents.find((entry) => entry.id === selectedAgentId)?.label ??
      toPrettyCase(selectedAgentId))
    : defaultLabel;

  const permissionMeta = permissionPolicy
    ? (permissionMetaByPolicy[permissionPolicy] ?? null)
    : null;
  const permissionIcon = permissionMeta?.icon ?? HandIcon;

  return (
    <>
      {showPreset && (
        <DropdownMenu>
          <DropdownMenuTriggerButton
            size="sm"
            icon={SlidersHorizontalIcon}
            label={
              resolvedPreset?.toLowerCase() !== 'default'
                ? presetLabel
                : undefined
            }
            showCaret={false}
          />
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('modelSelector.preset')}</DropdownMenuLabel>
            {presets.length > 0 ? (
              presets.map((preset) => (
                <DropdownMenuItem
                  key={preset}
                  icon={preset === resolvedPreset ? CheckIcon : undefined}
                  onClick={() => onPresetSelect?.(preset)}
                >
                  {toPrettyCase(preset)}
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled>{presetLabel}</DropdownMenuItem>
            )}
            {onAdvancedSettings && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem icon={GearIcon} onClick={onAdvancedSettings}>
                  {t('modelSelector.custom')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {showModelSelector && (
        <ModelSelectorPopover
          isOpen={isOpen}
          onOpenChange={handleOpenChange}
          trigger={
            <DropdownMenuTriggerButton
              size="sm"
              label={modelLabel}
              disabled={loadingModels}
            />
          }
          config={displayConfig ?? config}
          error={streamError}
          selectedProviderId={selectedProviderId}
          selectedModelId={selectedModelId}
          selectedReasoningId={selectedReasoningId}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onModelSelect={handleModelSelect}
          onReasoningSelect={handleReasoningSelect}
          recentModelEntries={recentModelEntries}
          showDefaultOption={showDefaultOption}
          onSelectDefault={() => handleModelSelect(null)}
          scrollRef={scrollRef}
          expandedProviderId={expandedProviderId}
          onExpandedProviderIdChange={setExpandedProviderId}
          resolvedTheme={resolvedTheme}
        />
      )}

      {showModelSelector && displaySelectedModel?.supports_fast && (
        <DropdownMenu>
          <DropdownMenuTriggerButton
            size="sm"
            icon={LightningIcon}
            label={fastEnabled ? t('modelSelector.fast') : undefined}
            showCaret={false}
          />
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('modelSelector.fast')}</DropdownMenuLabel>
            <DropdownMenuItem
              icon={fastEnabled ? CheckIcon : undefined}
              onClick={() => handleFastToggle(true)}
            >
              {t('modelSelector.fastOn')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={!fastEnabled ? CheckIcon : undefined}
              onClick={() => handleFastToggle(false)}
            >
              {t('modelSelector.fastOff')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {showPermissions && permissionPolicy && config.permissions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTriggerButton
            size="sm"
            icon={permissionIcon}
            showCaret={false}
          />
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>
              {t('modelSelector.permissions')}
            </DropdownMenuLabel>
            {config.permissions.map((policy) => {
              const meta = permissionMetaByPolicy[policy];
              return (
                <DropdownMenuItem
                  key={policy}
                  icon={meta?.icon ?? HandIcon}
                  onClick={() => handlePermissionPolicyChange(policy)}
                >
                  {meta?.label ?? toPrettyCase(policy)}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {config.agents.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTriggerButton size="sm" label={agentLabel} />
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('modelSelector.agent')}</DropdownMenuLabel>
            <DropdownMenuItem
              icon={selectedAgentId === null ? CheckIcon : undefined}
              onClick={() => handleAgentSelect(null)}
            >
              {t('modelSelector.default')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {config.agents.map((agentOption) => (
              <DropdownMenuItem
                key={agentOption.id}
                icon={
                  agentOption.id === selectedAgentId ? CheckIcon : undefined
                }
                onClick={() => handleAgentSelect(agentOption.id)}
              >
                {agentOption.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
