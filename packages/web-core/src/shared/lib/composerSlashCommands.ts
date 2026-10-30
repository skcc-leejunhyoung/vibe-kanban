import {
  BaseCodingAgent,
  PermissionPolicy,
  type ExecutorConfig,
} from 'shared/types';

/** Session settings belong to Vibe; changing the CLI's global config loses to its overrides. */
export function composerSlashCommandOverrides(
  prompt: string,
  config: ExecutorConfig
): Partial<ExecutorConfig> | null {
  if (
    config.executor !== BaseCodingAgent.CODEX &&
    config.executor !== BaseCodingAgent.CLAUDE_CODE
  ) {
    return null;
  }
  const match =
    /^\/(model|reasoning|plan|permissions|approvals)(?:\s+([^\n]*))?$/i.exec(
      prompt.trim()
    );
  if (!match) return null;
  const command = match[1].toLowerCase();
  const argument = (match[2] ?? '').trim();
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
  if (command === 'model') {
    if (/\s/.test(argument)) throw new Error('Usage: /model <model-id>');
    return { model_id: argument, reasoning_id: null };
  }
  if (command === 'reasoning') {
    const levels =
      config.executor === BaseCodingAgent.CODEX
        ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        : ['low', 'medium', 'high', 'xhigh', 'max'];
    if (!levels.includes(argument)) {
      throw new Error(`Usage: /reasoning ${levels.join('|')}`);
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
