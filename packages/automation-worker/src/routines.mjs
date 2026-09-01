const CRON_PARTS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

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
  if (trigger.type === 'schedule') {
    if (!trigger.at && !trigger.cron) throw new Error('schedule needs at or cron');
    if (trigger.at && !Number.isFinite(Date.parse(trigger.at))) throw new Error('invalid schedule time');
    if (trigger.cron) parseCron(trigger.cron);
    if (trigger.timezone) new Intl.DateTimeFormat('en-US', { timeZone: trigger.timezone }).format();
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
    const time = Date.parse(trigger.at);
    return time <= now.getTime() ? `once:${new Date(time).toISOString()}` : null;
  }
  const timezone = trigger.timezone || 'UTC';
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
  if (!cron.every((allowed, index) => allowed.has(values[index]))) return null;
  return `cron:${timezone}:${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function eventMatchesRoutine(routine, event) {
  if (!routine.enabled || routine.trigger?.type !== event.type) return false;
  if (event.originRoutineId === routine.id || event.routineChain?.includes(routine.id)) return false;
  const condition = routine.condition;
  if (!condition) return true;
  return Object.entries(condition).every(([key, value]) => event[key] === value);
}

export function redactEvent(event) {
  const safe = {};
  for (const [key, value] of Object.entries(event || {})) {
    if (/token|secret|credential|authorization|payload/i.test(key)) continue;
    safe[key] = typeof value === 'string' ? value.slice(0, 500) : value;
  }
  return safe;
}

function parseCron(value) {
  const fields = String(value || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron must have 5 fields');
  return fields.map((field, index) => parseCronField(field, ...CRON_PARTS[index]));
}

function parseCronField(field, min, max) {
  const values = new Set();
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
