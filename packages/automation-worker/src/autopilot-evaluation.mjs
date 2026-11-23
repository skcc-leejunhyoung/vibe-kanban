const percentile = (values, p) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
    : null;

// Gate logs record a skipped delegation only after the official checkpoint succeeds.
export function periodicSummary(rows) {
  const available = Array.isArray(rows);
  const outcomes = new Map();
  const fallbacks = new Map();
  for (const row of rows || []) {
    const item = row?.periodic;
    const at = Date.parse(row?.at);
    if (!item || !Number.isFinite(at)) continue;
    if (/^[a-z][a-z_]{1,50}$/.test(item.system_one_fallback || '')) {
      const reason = item.system_one_fallback;
      fallbacks.set(reason, (fallbacks.get(reason) || 0) + 1);
    }
    let key, status;
    if (
      item.status === 'handled' &&
      item.source === 'code' &&
      typeof item.evidence === 'string' &&
      item.evidence
    ) {
      key = `handled:${item.evidence}`;
      status = 'suppressed';
    } else if (
      ['started', 'queued', 'uncertain'].includes(item.status) &&
      typeof item.id === 'string' &&
      item.id
    ) {
      key = `agent:${item.id}`;
      status = item.status === 'uncertain' ? 'unresolved' : 'admitted';
    } else continue;
    const previous = outcomes.get(key);
    // A later uncertain observation cannot erase confirmed admission.
    if (
      previous?.status === 'admitted' ||
      (previous && status === 'suppressed')
    )
      continue;
    outcomes.set(key, {
      status,
      at,
      ms: Number.isFinite(row.ms) && row.ms >= 0 ? row.ms : null,
    });
  }
  const values = [...outcomes.values()];
  const times = values.map((row) => row.at);
  const durations = values
    .map((row) => row.ms)
    .filter((value) => value !== null);
  return {
    available,
    runs: values.length,
    suppressedRuns: values.filter((row) => row.status === 'suppressed').length,
    agentAdmissions: values.filter((row) => row.status === 'admitted').length,
    unresolvedRuns: values.filter((row) => row.status === 'unresolved').length,
    fallbackAttemptsByReason: Object.fromEntries(fallbacks),
    observedFrom: times.length
      ? new Date(Math.min(...times)).toISOString()
      : null,
    observedTo: times.length
      ? new Date(Math.max(...times)).toISOString()
      : null,
    gateP50Ms: percentile(durations, 0.5),
    gateP90Ms: percentile(durations, 0.9),
  };
}
