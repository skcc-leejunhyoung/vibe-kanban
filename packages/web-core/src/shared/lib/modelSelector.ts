import type {
  ModelInfo,
  ModelSelectorConfig,
  ReasoningOption,
} from 'shared/types';

function toPrettyCase(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function getSelectedModel(
  models: ModelInfo[],
  selectedProviderId: string | null,
  selectedModelId: string | null
): ModelInfo | null {
  if (!selectedModelId) return null;
  const selectedId = selectedModelId.toLowerCase();
  if (selectedProviderId) {
    const providerId = selectedProviderId.toLowerCase();
    return (
      models.find(
        (model) =>
          model.id.toLowerCase() === selectedId &&
          model.provider_id?.toLowerCase() === providerId
      ) ?? null
    );
  }
  return models.find((model) => model.id.toLowerCase() === selectedId) ?? null;
}

export function getReasoningLabel(
  options: ReasoningOption[],
  selectedId: string | null
): string | null {
  if (!selectedId) return null;
  return (
    options.find((option) => option.id === selectedId)?.label ??
    toPrettyCase(selectedId)
  );
}

export function escapeAttributeValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}

export function parseModelId(
  value?: string | null,
  hasProviders?: boolean
): {
  providerId: string | null;
  modelId: string | null;
} {
  if (!value) return { providerId: null, modelId: null };
  if (!hasProviders) return { providerId: null, modelId: value };
  const slashIdx = value.indexOf('/');
  if (slashIdx === -1) return { providerId: null, modelId: value };
  return {
    providerId: value.substring(0, slashIdx),
    modelId: value.substring(slashIdx + 1),
  };
}

export function resolveDefaultModelId(
  models: ModelInfo[],
  providerId: string | null,
  defaultModel: string | null | undefined,
  hasProviders?: boolean
): string | null {
  if (models.length === 0) return null;
  const scoped = providerId
    ? models.filter((model) => model.provider_id === providerId)
    : models;
  if (scoped.length === 0) return null;

  const { providerId: defaultProvider, modelId: defaultId } = parseModelId(
    defaultModel,
    hasProviders
  );
  if (
    defaultId &&
    (!providerId || !defaultProvider || providerId === defaultProvider)
  ) {
    const match = scoped.find((model) => model.id === defaultId);
    if (match) return match.id;
  }

  if (!defaultModel) return null;

  return scoped[0]?.id ?? null;
}

export function isModelAvailable(
  config: ModelSelectorConfig,
  providerId: string,
  modelId: string
): boolean {
  const providerLower = providerId.toLowerCase();
  const modelLower = modelId.toLowerCase();
  return config.models.some(
    (model) =>
      model.id.toLowerCase() === modelLower &&
      model.provider_id?.toLowerCase() === providerLower
  );
}

export function resolveDefaultReasoningId(
  options: ReasoningOption[]
): string | null {
  return (
    options.find((option) => option.is_default)?.id ?? options[0]?.id ?? null
  );
}

/**
 * Suffix appended to a model id when the "fast" service tier is enabled. The
 * backend strips it and turns on the fast tier (see codex resolve_model).
 */
export const FAST_SUFFIX = '-fast';

/**
 * Split a stored model id into its base id and whether the fast tier is on.
 * Only treats a `-fast` suffix as a fast toggle when the base model actually
 * advertises fast support, so unrelated ids ending in "-fast" pass through.
 */
export function splitFastSuffix(
  modelId: string | null | undefined,
  supportsFast: (baseId: string) => boolean
): { baseId: string | null; fast: boolean } {
  if (!modelId) return { baseId: modelId ?? null, fast: false };
  if (modelId.toLowerCase().endsWith(FAST_SUFFIX)) {
    const baseId = modelId.slice(0, -FAST_SUFFIX.length);
    if (supportsFast(baseId)) return { baseId, fast: true };
  }
  return { baseId: modelId, fast: false };
}

/**
 * Normalize a stored `provider/model` (or bare model) id by stripping the
 * `-fast` toggle suffix from the model part when the base model advertises fast
 * support, keeping any provider prefix. Returns the normalized id and whether
 * fast was on. Lets a preset/default model saved as `…-fast` resolve to the
 * real base model in the picker instead of a phantom `…-fast` entry.
 */
export function normalizeFastModelId(
  value: string | null | undefined,
  hasProviders: boolean,
  supportsFast: (baseId: string) => boolean
): { modelId: string | null; fast: boolean } {
  if (!value) return { modelId: value ?? null, fast: false };
  const { providerId, modelId } = parseModelId(value, hasProviders);
  if (!modelId) return { modelId: value, fast: false };
  const { baseId, fast } = splitFastSuffix(modelId, supportsFast);
  const base = baseId ?? modelId;
  return { modelId: providerId ? `${providerId}/${base}` : base, fast };
}
