import {
  BaseCodingAgent,
  PermissionPolicy,
  type ExecutorConfig,
  type ModelSelectorConfig,
} from 'shared/types';
import {
  FAST_SUFFIX,
  normalizeFastModelId,
  parseModelId,
} from './modelSelector';

/** Keep uploaded files in the draft while applying a standalone setting. */
export function splitComposerSettingsPrompt(prompt: string) {
  const attachments: string[] = [];
  const commandPrompt = prompt.replace(
    /^!?\[(?:\\.|[^\]\\\r\n])*\]\(\.vibe-attachments\/[^\r\n)]+\)[ \t]*\r?$/gm,
    (attachment) => {
      attachments.push(attachment.trim());
      return '';
    }
  );
  return {
    commandPrompt: commandPrompt.trim(),
    remainingMessage: attachments.join('\n\n'),
  };
}

/** Session settings belong to Vibe; changing the CLI's global config loses to its overrides. */
export function composerSlashCommandOverrides(
  prompt: string,
  config: ExecutorConfig,
  models?: ModelSelectorConfig | null
): Partial<ExecutorConfig> | null {
  if (
    config.executor !== BaseCodingAgent.CODEX &&
    config.executor !== BaseCodingAgent.CLAUDE_CODE
  ) {
    return null;
  }
  const match =
    /^\/(models?|reasoning|effort|config|settings|plan|permissions|approvals|fast)(?:\s+([^\n]*))?$/i.exec(
      prompt.trim()
    );
  if (!match) return null;
  const command = match[1].toLowerCase();
  const argument = (match[2] ?? '').trim();
  if (command === 'config' || command === 'settings') {
    if (!argument || argument === '--help') return null;
    const overrides: Partial<ExecutorConfig> = {};
    let reasoningSet = false;
    for (const setting of argument.split(/\s+/)) {
      const [key, ...parts] = setting.split('=');
      const value = parts.join('=');
      const mapped =
        key === 'model'
          ? 'model'
          : ['effort', 'effortLevel', 'reasoning'].includes(key)
            ? 'reasoning'
            : null;
      if (!mapped || !value)
        throw new Error(
          'Usage: /config model=<id> effort=<level>; use Vibe Settings for other preferences.'
        );
      const partial = composerSlashCommandOverrides(
        `/${mapped} ${value}`,
        config,
        models
      );
      if (!partial) throw new Error('Usage: /config model=<id> effort=<level>');
      if (mapped === 'model' && reasoningSet) delete partial.reasoning_id;
      if (mapped === 'reasoning') reasoningSet = true;
      Object.assign(overrides, partial);
    }
    return overrides;
  }
  if (command === 'fast') {
    if (config.executor !== BaseCodingAgent.CODEX || argument === 'status') {
      return null;
    }
    if (!['', 'on', 'off'].includes(argument)) {
      throw new Error('Usage: /fast [on|off|status]');
    }
    if (!models)
      throw new Error('Wait for the model list before changing fast mode.');
    const hasProviders = models.providers.length > 0;
    const stored = config.model_id ?? models.default_model;
    const { providerId } = parseModelId(stored, hasProviders);
    const supportsFast = (id: string) =>
      models.models.some(
        (model) =>
          model.id.toLowerCase() === id.toLowerCase() &&
          (!providerId ||
            model.provider_id?.toLowerCase() === providerId.toLowerCase()) &&
          model.supports_fast
      );
    const { modelId, fast } = normalizeFastModelId(
      stored,
      hasProviders,
      supportsFast
    );
    const { modelId: baseId } = parseModelId(modelId, hasProviders);
    if (!modelId || !baseId || !supportsFast(baseId)) {
      throw new Error('Select a model that supports fast mode first.');
    }
    const enabled = argument === 'on' || (!argument && !fast);
    return {
      model_id: enabled ? `${modelId}${FAST_SUFFIX}` : modelId,
      reasoning_id: config.reasoning_id ?? null,
    };
  }
  if (command === 'plan') {
    if (!['', 'on', 'off'].includes(argument)) return null;
    const enabled =
      argument === 'on' ||
      (!argument && config.permission_policy !== PermissionPolicy.PLAN);
    return {
      permission_policy: enabled
        ? PermissionPolicy.PLAN
        : PermissionPolicy.SUPERVISED,
    };
  }
  if (!argument) return null;
  if (command === 'model' || command === 'models') {
    if (command === 'models' && config.executor !== BaseCodingAgent.CODEX)
      return null;
    if (/\s/.test(argument)) throw new Error('Usage: /model <model-id>');
    return { model_id: argument, reasoning_id: null };
  }
  if (command === 'reasoning' || command === 'effort') {
    if (
      argument === 'status' &&
      config.executor === BaseCodingAgent.CLAUDE_CODE
    )
      return null;
    const levels =
      config.executor === BaseCodingAgent.CODEX
        ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        : ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
    if (!levels.includes(argument)) {
      throw new Error(`Usage: /${command} ${levels.join('|')}`);
    }
    return { reasoning_id: argument };
  }
  switch (argument) {
    case 'auto':
      return { permission_policy: PermissionPolicy.AUTO };
    case 'supervised':
      return { permission_policy: PermissionPolicy.SUPERVISED };
    case 'plan':
      return { permission_policy: PermissionPolicy.PLAN };
    case 'dont_ask':
      return { permission_policy: PermissionPolicy.DONT_ASK };
    default:
      throw new Error('Usage: /permissions auto|supervised|plan|dont_ask');
  }
}

export function composerSessionCommand(
  prompt: string,
  executor: BaseCodingAgent
) {
  if (![BaseCodingAgent.CODEX, BaseCodingAgent.CLAUDE_CODE].includes(executor))
    return null;
  const match =
    /^\/(rename|ps|warnings|config|settings)(?:[ \t]+([^\r\n]*))?$/i.exec(
      prompt.trim()
    );
  if (!match) return null;
  const command = match[1].toLowerCase();
  const argument = (match[2] ?? '').trim();
  if (command === 'config' || command === 'settings') {
    if (argument === '--help') return { command: 'config-help', argument: '' };
    return argument ? null : { command: 'settings', argument: '' };
  }
  if (command !== 'rename' && argument) throw new Error(`Usage: /${command}`);
  return { command, argument };
}
