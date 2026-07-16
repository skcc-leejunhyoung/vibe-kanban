import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BaseCodingAgent,
  ExecutorConfig,
  ExecutorProfile,
  ExecutorProfileId,
} from 'shared/types';
import {
  getInitialExecutorConfig,
  getVariantOptions,
} from '@/shared/lib/executor';
import { withRecentReasoning } from '@/shared/lib/recentModels';
import { usePresetOptions } from '@/shared/hooks/usePresetOptions';
import { useModelSelectorConfig } from '@/shared/hooks/useExecutorDiscovery';

function getProfileKey(
  executor: BaseCodingAgent | null,
  variant: string | null
): string | null {
  if (!executor) return null;
  return `${executor}:${variant ?? 'DEFAULT'}`;
}

const OVERRIDE_FIELDS = [
  'model_id',
  'agent_id',
  'reasoning_id',
  'permission_policy',
] as const;

/**
 * Resolves effective executor.
 * userSelections.executor → scratch → lastUsedConfig → configDefault → first available
 */
function useEffectiveExecutor(
  userSelections: Partial<ExecutorConfig>,
  profiles: Record<string, ExecutorProfile> | null,
  scratchConfig: ExecutorConfig | null | undefined,
  lastUsedConfig: ExecutorConfig | null,
  configExecutorProfile: ExecutorProfileId | null | undefined,
  disabledExecutors: BaseCodingAgent[] | undefined
) {
  const options = useMemo(
    () => Object.keys(profiles ?? {}) as BaseCodingAgent[],
    [profiles]
  );

  // First enabled agent, used as the last-resort fallback so a hidden agent is
  // never auto-selected. Falls back to the full list if every agent is hidden.
  const fallback = useMemo(() => {
    const disabled = new Set(disabledExecutors ?? []);
    const enabled = options.filter((e) => !disabled.has(e));
    return (enabled.length > 0 ? enabled : options)[0] ?? null;
  }, [options, disabledExecutors]);

  const effective = useMemo(
    () =>
      userSelections.executor ??
      scratchConfig?.executor ??
      lastUsedConfig?.executor ??
      configExecutorProfile?.executor ??
      fallback,
    [
      userSelections.executor,
      scratchConfig,
      lastUsedConfig,
      configExecutorProfile,
      fallback,
    ]
  );

  return { effective, options };
}

/**
 * Resolves effective variant.
 * userSelections.variant → scratch (if same executor) → lastUsedConfig (if same executor)
 * → configDefault → DEFAULT/first
 */
function useEffectiveVariant(
  userSelections: Partial<ExecutorConfig>,
  effectiveExecutor: BaseCodingAgent | null,
  profiles: Record<string, ExecutorProfile> | null,
  scratchConfig: ExecutorConfig | null | undefined,
  lastUsedConfig: ExecutorConfig | null,
  configExecutorProfile: ExecutorProfileId | null | undefined
) {
  const options = useMemo(
    () => getVariantOptions(effectiveExecutor, profiles),
    [effectiveExecutor, profiles]
  );

  const wasUserSelected = 'variant' in userSelections;

  const resolved = useMemo(() => {
    if (wasUserSelected) return userSelections.variant ?? null;

    if (
      scratchConfig !== undefined &&
      scratchConfig?.executor === effectiveExecutor &&
      scratchConfig?.variant !== undefined
    ) {
      return scratchConfig.variant ?? null;
    }

    if (lastUsedConfig?.executor === effectiveExecutor) {
      return lastUsedConfig.variant ?? null;
    }

    if (configExecutorProfile?.executor === effectiveExecutor) {
      return configExecutorProfile.variant ?? null;
    }

    return (options.includes('DEFAULT') ? 'DEFAULT' : options[0]) ?? null;
  }, [
    wasUserSelected,
    userSelections.variant,
    scratchConfig,
    effectiveExecutor,
    lastUsedConfig,
    configExecutorProfile,
    options,
  ]);

  return { resolved, options, wasUserSelected };
}

/**
 * Resolves each override field independently through the fallback chain:
 * userSelections[field] → scratch[field] → lastUsed[field] → preset[field]
 */
function useEffectiveOverrides(
  effectiveExecutor: BaseCodingAgent | null,
  resolvedVariant: string | null,
  userSelections: Partial<ExecutorConfig>,
  scratchConfig: ExecutorConfig | null | undefined,
  lastUsedConfig: ExecutorConfig | null,
  presetOptions: ExecutorConfig | null | undefined
) {
  return useMemo((): ExecutorConfig | null => {
    if (!effectiveExecutor) return null;

    const profileKey = getProfileKey(effectiveExecutor, resolvedVariant);
    const scratchMatches = scratchConfig
      ? getProfileKey(scratchConfig.executor, scratchConfig.variant ?? null) ===
        profileKey
      : false;
    const lastUsedMatches = lastUsedConfig
      ? getProfileKey(
          lastUsedConfig.executor,
          lastUsedConfig.variant ?? null
        ) === profileKey
      : false;

    const resolved: ExecutorConfig = {
      executor: effectiveExecutor,
      variant: resolvedVariant,
    };

    for (const field of OVERRIDE_FIELDS) {
      const modelMustMatch = field === 'reasoning_id';
      const scratchModelMatches =
        !modelMustMatch || scratchConfig?.model_id === resolved.model_id;
      const lastUsedModelMatches =
        !modelMustMatch || lastUsedConfig?.model_id === resolved.model_id;

      const value =
        field in userSelections
          ? userSelections[field]
          : ((scratchMatches && scratchModelMatches
              ? scratchConfig?.[field]
              : undefined) ??
            (lastUsedMatches && lastUsedModelMatches
              ? lastUsedConfig?.[field]
              : undefined) ??
            presetOptions?.[field]);
      if (value !== undefined) {
        (resolved as Record<string, unknown>)[field] = value;
      }
    }

    return resolved;
  }, [
    effectiveExecutor,
    resolvedVariant,
    userSelections,
    scratchConfig,
    lastUsedConfig,
    presetOptions,
  ]);
}

interface UseExecutorConfigOptions {
  profiles: Record<string, ExecutorProfile> | null;
  lastUsedConfig: ExecutorConfig | null;
  scratchConfig?: ExecutorConfig | null;
  configExecutorProfile?: ExecutorProfileId | null;
  /** Agents the user has hidden from selection. */
  disabledExecutors?: BaseCodingAgent[];
  workspaceId?: string;
  sessionId?: string;
  onPersist?: (config: ExecutorConfig) => void;
}

interface UseExecutorConfigResult {
  executorConfig: ExecutorConfig | null;
  effectiveExecutor: BaseCodingAgent | null;
  selectedVariant: string | null;
  executorOptions: BaseCodingAgent[];
  variantOptions: string[];
  presetOptions: ExecutorConfig | null | undefined;
  setExecutor: (executor: BaseCodingAgent) => void;
  setVariant: (variant: string | null) => void;
  setOverrides: (partial: Partial<ExecutorConfig>) => void;
}

/** Unified executor + variant + model selector overrides management. */
export function useExecutorConfig({
  profiles,
  lastUsedConfig,
  scratchConfig,
  configExecutorProfile,
  disabledExecutors,
  workspaceId,
  sessionId,
  onPersist,
}: UseExecutorConfigOptions): UseExecutorConfigResult {
  const [userSelections, setUserSelections] = useState<Partial<ExecutorConfig>>(
    {}
  );

  const executor = useEffectiveExecutor(
    userSelections,
    profiles,
    scratchConfig,
    lastUsedConfig,
    configExecutorProfile,
    disabledExecutors
  );

  // Hide disabled agents from selection, but keep the effective one visible so
  // the current selection never disappears.
  const executorOptions = useMemo(() => {
    const disabled = new Set(disabledExecutors ?? []);
    return executor.options.filter(
      (e) => !disabled.has(e) || e === executor.effective
    );
  }, [executor.options, executor.effective, disabledExecutors]);

  const variant = useEffectiveVariant(
    userSelections,
    executor.effective,
    profiles,
    scratchConfig,
    lastUsedConfig,
    configExecutorProfile
  );

  const { data: presetOptions } = usePresetOptions(
    executor.effective,
    variant.resolved
  );
  const { config: modelSelectorConfig } = useModelSelectorConfig(
    executor.effective,
    { workspaceId: sessionId ? workspaceId : undefined, sessionId }
  );

  const resolvedExecutorConfig = useEffectiveOverrides(
    executor.effective,
    variant.resolved,
    userSelections,
    scratchConfig,
    lastUsedConfig,
    presetOptions
  );
  const executorConfig = useMemo(
    () =>
      withRecentReasoning(
        resolvedExecutorConfig,
        profiles,
        modelSelectorConfig
      ),
    [resolvedExecutorConfig, profiles, modelSelectorConfig]
  );

  const profileKey = getProfileKey(executor.effective, variant.resolved);
  const prevProfileKeyRef = useRef<string | null>(profileKey);
  useEffect(() => {
    const prev = prevProfileKeyRef.current;
    prevProfileKeyRef.current = profileKey;
    if (prev !== null && prev !== profileKey) {
      setUserSelections((s) => {
        const { executor, variant, ...rest } = s;
        if (Object.keys(rest).length === 0) return s;
        return { executor, variant };
      });
    }
  }, [profileKey]);

  const onPersistRef = useRef(onPersist);
  onPersistRef.current = onPersist;

  const persist = useCallback((config: ExecutorConfig | null) => {
    if (config) onPersistRef.current?.(config);
  }, []);

  // Setting executor → replaces entire selections with just { executor }.
  // Clears variant + all override fields.
  const setExecutor = useCallback(
    (exec: BaseCodingAgent) => {
      setUserSelections({ executor: exec });
      // Persist with auto-resolved variant (no overrides)
      persist(getInitialExecutorConfig(exec, profiles));
    },
    [profiles, persist]
  );

  // Setting variant → keeps executor, sets variant, clears all override fields.
  // Since 'variant' is in userSelections → variantWasUserSelected=true
  // → override fields fall through to preset options for the new variant.
  const setVariant = useCallback(
    (v: string | null) => {
      setUserSelections((prev) => ({ executor: prev.executor, variant: v }));
      if (executor.effective) {
        persist({ executor: executor.effective, variant: v });
      }
    },
    [executor.effective, persist]
  );

  // Model selector updates individual override fields (merge into existing).
  // Changing model clears reasoning selection; other overrides are independent.
  const setOverrides = useCallback(
    (partial: Partial<ExecutorConfig>) => {
      setUserSelections((prev) => {
        const next = { ...prev, ...partial };
        if ('model_id' in partial && !('reasoning_id' in partial)) {
          delete next.reasoning_id;
        }
        const persistedConfig = executor.effective
          ? {
              ...next,
              executor: executor.effective,
              variant: variant.resolved,
            }
          : null;
        // Persist with current effective executor/variant
        if (persistedConfig) {
          persist(persistedConfig);
        }
        return next;
      });
    },
    [executor.effective, variant.resolved, persist]
  );

  return {
    executorConfig,
    effectiveExecutor: executor.effective,
    selectedVariant: variant.resolved,
    executorOptions,
    variantOptions: variant.options,
    presetOptions,
    setExecutor,
    setVariant,
    setOverrides,
  };
}
