const CRON_PARTS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];
const PERMISSION_POLICIES = new Set(['AUTO', 'DONT_ASK', 'SUPERVISED', 'PLAN']);
const SANDBOX_POLICIES = new Set([
  'auto',
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

export function normalizeRoutine(input) {
  if (!input || typeof input !== 'object') throw new Error('invalid routine');
  const trigger = input.trigger || {};
  const action = input.action || {};
  if (!['schedule', 'issue_created', 'execution_completed', 'workspace_archived'].includes(trigger.type)) {
    throw new Error('unsupported routine trigger');
  }
  if (!['create_issue', 'start_workspace', 'send_prompt', 'notification'].includes(action.type)) {
    throw new Error('unsupported routine action');
  }
  if (!action.connectorId) throw new Error('action connectorId is required');
  if (!action.input || typeof action.input !== 'object' || Array.isArray(action.input))
    throw new Error('action input must be an object');
  if (
    input.condition !== undefined &&
    input.condition !== null &&
    (typeof input.condition !== 'object' || Array.isArray(input.condition))
  ) throw new Error('condition must be an object or null');
  if (
    ['start_workspace', 'send_prompt', 'notification'].includes(action.type) &&
    !action.targetHostId
  )
    throw new Error(`${action.type} targetHostId is required`);
  const actionInput = action.input || {};
  if (action.type === 'create_issue' && !actionInput.title)
    throw new Error('create_issue title is required');
  if (action.type === 'start_workspace') {
    if (!actionInput.prompt || !Array.isArray(actionInput.repos) || !actionInput.repos.length)
      throw new Error('start_workspace prompt and repos are required');
    if (!actionInput.executor_config?.executor)
      throw new Error('start_workspace executor is required');
    if (!actionInput.executor_config?.variant)
      throw new Error('start_workspace executor variant is required');
    if (!actionInput.linked_issue?.remote_project_id || !actionInput.linked_issue?.issue_id)
      throw new Error('start_workspace project and issue are required');
    if (!actionInput.executor_config?.permission_policy)
      throw new Error('start_workspace approval policy is required');
    if (!PERMISSION_POLICIES.has(actionInput.executor_config.permission_policy))
      throw new Error('start_workspace approval policy is invalid');
    if (!SANDBOX_POLICIES.has(actionInput.executor_config.sandbox_policy))
      throw new Error('start_workspace sandbox policy is required');
    if (!Number.isFinite(actionInput.max_execution_seconds) || actionInput.max_execution_seconds < 1)
      throw new Error('start_workspace max execution time is required');
  }
  if (action.type === 'send_prompt') {
    if (!actionInput.sessionId || !actionInput.prompt)
      throw new Error('send_prompt sessionId and prompt are required');
    if (!actionInput.executor_config?.executor)
      throw new Error('send_prompt executor is required');
    if (!actionInput.scope?.projectId || !actionInput.scope?.repositoryIds?.length)
      throw new Error('send_prompt project and repository scope are required');
    if (!actionInput.executor_config?.permission_policy)
      throw new Error('send_prompt approval policy is required');
    if (!PERMISSION_POLICIES.has(actionInput.executor_config.permission_policy))
      throw new Error('send_prompt approval policy is invalid');
    if (!SANDBOX_POLICIES.has(actionInput.executor_config.sandbox_policy))
      throw new Error('send_prompt sandbox policy is required');
  }
  if (action.type === 'notification' && (!actionInput.title || !actionInput.message))
    throw new Error('notification title and message are required');
  if (trigger.type === 'schedule') {
    if (!trigger.at && !trigger.cron) throw new Error('schedule needs at or cron');
    if (trigger.at) zonedDate(trigger.at, trigger.timezone);
    if (trigger.cron) parseCron(trigger.cron);
    if (!trigger.timezone) throw new Error('schedule timezone is required');
    new Intl.DateTimeFormat('en-US', { timeZone: trigger.timezone }).format();
  }
  return {
    id: String(input.id || ''),
    name: String(input.name || input.id || 'Untitled routine'),
    enabled: Boolean(input.enabled),
    trigger: structuredClone(trigger),
    condition: input.condition ? structuredClone(input.condition) : null,
    action: structuredClone(action),
    createdAt: Number(input.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

export function scheduleOccurrence(routine, now = new Date()) {
  const trigger = routine.trigger || {};
  if (trigger.type !== 'schedule') return null;
  if (trigger.at) {
    const time = zonedDate(trigger.at, trigger.timezone).getTime();
    return time <= now.getTime() ? `once:${new Date(time).toISOString()}` : null;
  }
  const timezone = trigger.timezone;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  const values = [Number(parts.minute), Number(parts.hour), Number(parts.day), Number(parts.month),
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)];
  const cron = parseCron(trigger.cron);
  const minuteHourMonthMatch = [0, 1, 3].every((index) =>
    cron[index].has(values[index])
  );
  const dayOfMonthMatch = cron[2].has(values[2]);
  const dayOfWeekMatch = cron[4].has(values[4]);
  const dayMatches =
    cron[2].wildcard || cron[4].wildcard
      ? dayOfMonthMatch && dayOfWeekMatch
      : dayOfMonthMatch || dayOfWeekMatch;
  if (!minuteHourMonthMatch || !dayMatches) return null;
  return `cron:${timezone}:${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function zonedDate(value, timezone) {
  if (/(?:Z|[+-]\d\d:\d\d)$/i.test(value)) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('invalid schedule time');
    return date;
  }
  const match = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!match) throw new Error('invalid schedule time');
  const wanted = match.slice(1).map(Number);
  let timestamp = Date.UTC(
    wanted[0],
    wanted[1] - 1,
    wanted[2],
    wanted[3],
    wanted[4],
    wanted[5] || 0
  );
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)])
    );
    const actual = Date.UTC(
      parts.year, parts.month - 1, parts.day,
      parts.hour, parts.minute, parts.second
    );
    timestamp += Date.UTC(
      wanted[0], wanted[1] - 1, wanted[2],
      wanted[3], wanted[4], wanted[5] || 0
    ) - actual;
  }
  const resolved = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  if (
    [resolved.year, resolved.month, resolved.day, resolved.hour, resolved.minute, resolved.second]
      .some((part, index) => part !== [wanted[0], wanted[1], wanted[2], wanted[3], wanted[4], wanted[5] || 0][index])
  ) throw new Error('schedule time does not exist in timezone');
  return new Date(timestamp);
}

export function eventMatchesRoutine(routine, event) {
  if (!routine.enabled || routine.trigger?.type !== event.type) return false;
  if (
    event.originRoutineId === routine.id ||
    event.routineChain?.includes(routine.id)
  )
    return false;
  const condition = routine.condition;
  if (!condition) return true;
  return Object.entries(condition).every(
    ([key, value]) => ['ruleId', 'expected'].includes(key) || event[key] === value
  );
}

export function routineEventKey(routineId, event) {
  return `${routineId}:${event.source || 'unknown'}:${event.type}:${event.id}`;
}

export function automationEventKey(event) {
  return `${event.source || 'vibe'}:${event.type}:${event.id}`;
}

export function isIndeterminateActionError(error) {
  return /409[\s\S]*automation action is already running/i.test(String(error));
}

export function validateRoutineScope(bridge, input) {
  const projectId = input.linked_issue?.remote_project_id || input.scope?.projectId;
  if (projectId && !bridge.projectIds?.includes(projectId))
    throw new Error(`project is outside target host scope: ${projectId}`);
  for (const repo of input.repos || []) {
    if (!bridge.repositoryIds?.includes(repo.repo_id))
      throw new Error(`repository is outside target host scope: ${repo.repo_id}`);
  }
  for (const repositoryId of input.scope?.repositoryIds || []) {
    if (!bridge.repositoryIds?.includes(repositoryId))
      throw new Error(`repository is outside target host scope: ${repositoryId}`);
  }
}

export function redactEvent(value, key = '') {
  if (/token|secret|credential|authorization|password/i.test(key)) return undefined;
  if (typeof value === 'string') return value.slice(0, 500);
  if (Array.isArray(value))
    return value.map((item) => redactEvent(item)).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .map(([childKey, child]) => [childKey, redactEvent(child, childKey)])
      .filter(([, child]) => child !== undefined)
  );
}

export function routineRunTrigger(event) {
  const keys = [
    'id',
    'type',
    'source',
    'issueId',
    'executionProcessId',
    'workspaceId',
    'projectId',
    'sessionId',
  ];
  return Object.fromEntries(
    keys
      .filter((key) => event?.[key] !== undefined)
      .map((key) => [key, redactEvent(event[key], key)])
  );
}

function parseCron(value) {
  const fields = String(value || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron must have 5 fields');
  return fields.map((field, index) => parseCronField(field, ...CRON_PARTS[index]));
}

function parseCronField(field, min, max) {
  const values = new Set();
  values.wildcard = field === '*' || field.startsWith('*/');
  for (const item of field.split(',')) {
    const [range, stepText] = item.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error('invalid cron step');
    let start;
    let end;
    if (range === '*') [start, end] = [min, max];
    else if (range.includes('-')) [start, end] = range.split('-').map(Number);
    else [start, end] = [Number(range), Number(range)];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error('invalid cron field');
    }
    for (let number = start; number <= end; number += step) values.add(number);
  }
  return values;
}
