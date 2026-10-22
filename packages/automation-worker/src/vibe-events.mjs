// Vibe journal events as worker events, the prompt template a routine renders
// them into, and the per-routine coalescer that turns a burst of events into a
// single routine run (one Autopilot turn instead of one turn per event).

export const DEFAULT_KINDS = [
  'process.',
  'approval.',
  'workspace.status_note',
  'vibe.phase',
  'cloud.notification',
];

export const COALESCE_DEFAULTS = {
  windowSeconds: 30,
  minIntervalSeconds: 120,
  maxPerHour: 20,
  immediate: [],
};

const HOUR_MS = 3600000;

// Prefix match, same rule as the server journal (`process.` selects every
// process event, `process.failed` just that one). No prefixes = everything.
export function kindMatches(kind, prefixes) {
  if (!Array.isArray(prefixes) || !prefixes.length) return true;
  const value = String(kind || '');
  return prefixes.some((prefix) => {
    const wanted = String(prefix).replace(/\*$/, '');
    return value === wanted || value.startsWith(wanted);
  });
}

// The workspace a journal event belongs to. Cloud notifications carry it in
// the notification payload (the Autopilot sends its own with `--ws autopilot`),
// not on the event, so excluding the Autopilot's own output needs both.
export function eventWorkspaceId(event) {
  return (
    event?.workspace_id ||
    event?.data?.payload?.workspace_id ||
    event?.data?.workspace_id ||
    null
  );
}

export function journalEventToWorkerEvent(hostId, event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const exit = data.exit_code;
  const title = [
    event.kind,
    data.name || data.title,
    exit !== undefined && exit !== null ? `exit ${exit}` : null,
    data.status_note ? String(data.status_note).slice(0, 120) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    id: `${hostId}:${event.cursor}`,
    source: 'vibe',
    type: 'vk_event',
    kind: String(event.kind || ''),
    cursor: event.cursor,
    hostId,
    workspaceId: eventWorkspaceId(event),
    sessionId: event.session_id || null,
    executionId: event.execution_id || null,
    at: event.at || null,
    title,
    data,
  };
}

export function eventLine(event) {
  const ids = [
    ['ws', event.workspaceId],
    ['session', event.sessionId],
    ['exec', event.executionId],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label} ${value}`)
    .join(', ');
  const head = [event.kind || event.type, event.hostId, event.title]
    .filter(Boolean)
    .join(' ');
  return `- ${head}${ids ? ` (${ids})` : ''}`;
}

// `{{count}}`, `{{cursor}}`, `{{hostIds}}` and `{{events}}` in a prompt. A
// single (non-batch) event renders as a one-line batch; prompts without
// placeholders pass through unchanged.
export function renderPromptTemplate(prompt, event) {
  const events = Array.isArray(event?.events)
    ? event.events
    : event
      ? [event]
      : [];
  const hostIds =
    event?.hostIds || [...new Set(events.map((item) => item.hostId).filter(Boolean))];
  const values = {
    count: String(event?.count ?? events.length),
    cursor: String(event?.cursor ?? ''),
    hostIds: hostIds.join(', '),
    events: events.map(eventLine).join('\n'),
  };
  return String(prompt ?? '').replace(
    /\{\{\s*(count|cursor|hostIds|events)\s*\}\}/g,
    (_, key) => values[key]
  );
}

function batchEvent(events) {
  return {
    id: `batch:${events[0].id}..${events[events.length - 1].id}`,
    source: 'vibe',
    type: 'vk_event_batch',
    count: events.length,
    events,
    cursor: events[events.length - 1].cursor ?? null,
    hostIds: [...new Set(events.map((item) => item.hostId).filter(Boolean))],
  };
}

// Per-routine buffer. Flushes `windowSeconds` after the LAST appended event,
// immediately for `immediate` kinds, never sooner than `minIntervalSeconds`
// after the previous flush and never more than `maxPerHour` times per rolling
// hour (held events merge into the next flush). Buffers live in memory only;
// the connector cursor is what survives a restart.
export function createCoalescer({
  onFlush,
  onError = (error) => console.error(error),
  now = Date.now,
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = clearTimeout,
} = {}) {
  const buffers = new Map();

  function entry(routineId) {
    let item = buffers.get(routineId);
    if (!item) {
      item = { events: [], timer: null, flushAt: 0, lastFlushAt: 0, flushes: [] };
      buffers.set(routineId, item);
    }
    return item;
  }

  function earliestAllowed(item, settings, at) {
    item.flushes = item.flushes.filter((time) => time > at - HOUR_MS);
    let earliest = item.lastFlushAt
      ? item.lastFlushAt + settings.minIntervalSeconds * 1000
      : 0;
    if (settings.maxPerHour > 0 && item.flushes.length >= settings.maxPerHour) {
      earliest = Math.max(
        earliest,
        item.flushes[item.flushes.length - settings.maxPerHour] + HOUR_MS
      );
    }
    return earliest;
  }

  function arm(routine, item, at) {
    const settings = { ...COALESCE_DEFAULTS, ...(routine.coalesce || {}) };
    const urgent = item.events.some((event) =>
      settings.immediate.length ? kindMatches(event.kind, settings.immediate) : false
    );
    const desired = urgent ? at : at + settings.windowSeconds * 1000;
    const flushAt = Math.max(desired, earliestAllowed(item, settings, at));
    if (item.timer) clearTimer(item.timer);
    item.flushAt = flushAt;
    item.timer = setTimer(
      () => flush(routine.id).catch(onError),
      Math.max(0, flushAt - now())
    );
  }

  function add(routine, event) {
    const item = entry(routine.id);
    item.events.push(event);
    arm(routine, item, now());
    return item.events.length;
  }

  async function flush(routineId) {
    const item = buffers.get(routineId);
    if (!item || !item.events.length) return null;
    if (item.timer) clearTimer(item.timer);
    item.timer = null;
    const events = item.events.splice(0);
    const at = now();
    item.lastFlushAt = at;
    item.flushes.push(at);
    const batch = batchEvent(events);
    await onFlush(routineId, batch);
    return batch;
  }

  function pending(routineId) {
    return buffers.get(routineId)?.events.length || 0;
  }

  return { add, flush, pending };
}
