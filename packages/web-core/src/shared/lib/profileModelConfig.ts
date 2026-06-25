import { BaseCodingAgent } from 'shared/types';
import type { ExecutorConfig } from 'shared/types';

/**
 * Bridges between an executor's raw profile JSON (the per-agent defaults edited
 * in Settings) and the {@link ExecutorConfig} shape consumed by the workspace
 * model selector. This lets the same model/effort picker drive both the
 * per-session overrides (workspace) and the stored per-agent defaults
 * (settings).
 *
 * The field maps mirror the backend `apply_overrides` / `get_preset_options`
 * logic in `crates/executors/src/executors/*.rs`. Keep them in sync if a
 * profile renames its model/effort/agent field.
 */

/** Profile field that stores the model id (shared by every executor). */
const MODEL_FIELD = 'model';

/**
 * Per-executor profile field that stores the reasoning effort, keyed by the
 * model selector's `reasoning_id`. Executors absent here do not accept a
 * reasoning override from the model selector (their `apply_overrides` ignores
 * `reasoning_id`), exactly as in the workspace UI — their effort, when they
 * have one, stays editable through the raw JSON form.
 */
const REASONING_FIELD: Partial<Record<BaseCodingAgent, string>> = {
  [BaseCodingAgent.CLAUDE_CODE]: 'effort',
  [BaseCodingAgent.CODEX]: 'model_reasoning_effort',
  [BaseCodingAgent.CURSOR_AGENT]: 'reasoning',
  [BaseCodingAgent.OPENCODE]: 'variant',
};

/** Per-executor profile field that stores the agent-mode override. */
const AGENT_FIELD: Partial<Record<BaseCodingAgent, string>> = {
  [BaseCodingAgent.CLAUDE_CODE]: 'agent',
  [BaseCodingAgent.OPENCODE]: 'agent',
  [BaseCodingAgent.QWEN_CODE]: 'agent',
};

type ProfileData = Record<string, unknown>;

/**
 * Profile fields the model selector owns. The raw JSON form hides these so the
 * two editors never disagree about the same value.
 */
export function getModelSelectorProfileFields(
  executor: BaseCodingAgent
): string[] {
  return [MODEL_FIELD, REASONING_FIELD[executor], AGENT_FIELD[executor]].filter(
    (field): field is string => Boolean(field)
  );
}

/**
 * Reads a profile's stored defaults into the {@link ExecutorConfig} shape the
 * model selector renders as the current selection. Inverse of
 * {@link applyModelConfigToProfile}.
 */
export function profileToExecutorConfig(
  executor: BaseCodingAgent,
  variant: string | null,
  profile: ProfileData | null | undefined
): ExecutorConfig {
  const read = (field: string | undefined): string | null => {
    if (!field || !profile) return null;
    const value = profile[field];
    return typeof value === 'string' ? value : null;
  };
  return {
    executor,
    variant,
    model_id: read(MODEL_FIELD),
    reasoning_id: read(REASONING_FIELD[executor]),
    agent_id: read(AGENT_FIELD[executor]),
    // Permission policy is left to the raw JSON form — its profile mapping is
    // executor-specific (plan/approvals, ask_for_approval, autonomy, ...).
    permission_policy: null,
  };
}

/**
 * Writes a model-selector override back into the raw profile JSON. Only the
 * model/reasoning/agent fields are touched; every other field is preserved.
 * Changing the model clears the stale reasoning effort, mirroring the
 * workspace selector (`useExecutorConfig.setOverrides`).
 */
export function applyModelConfigToProfile(
  executor: BaseCodingAgent,
  profile: ProfileData | null | undefined,
  partial: Partial<ExecutorConfig>
): ProfileData {
  const reasoningField = REASONING_FIELD[executor];
  const agentField = AGENT_FIELD[executor];
  const next: ProfileData = { ...(profile ?? {}) };

  const set = (field: string | undefined, value: string | null | undefined) => {
    if (!field) return;
    if (value == null) delete next[field];
    else next[field] = value;
  };

  if ('model_id' in partial) {
    set(MODEL_FIELD, partial.model_id);
    // A new model may not support the previously chosen effort; drop it unless
    // the same update also carries an explicit reasoning_id.
    if (!('reasoning_id' in partial)) set(reasoningField, null);
  }
  if ('reasoning_id' in partial) set(reasoningField, partial.reasoning_id);
  if ('agent_id' in partial) set(agentField, partial.agent_id);

  return next;
}
