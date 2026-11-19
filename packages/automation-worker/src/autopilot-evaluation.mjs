const routes = ['routine_result', 'needs_investigation', 'needs_user'];
const percentile = (values, p) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
    : null;

// Gate logs record a skipped delegation only after the official checkpoint succeeds.
function periodicSummary(rows) {
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

export function evaluateAutopilotRecords({
  observations = {},
  claims = {},
  labels = [],
  prices = {},
  periodicLog,
}) {
  const records = new Map(
    Object.entries(observations).map(([key, row]) => [key, { shadow: row }])
  );
  for (const [key, claim] of Object.entries(claims)) {
    if (!claim.autopilotRouting && !claim.autopilotShadow) continue;
    const row = records.get(key) || {};
    row.active = claim.autopilotRouting;
    row.shadow ||= claim.autopilotShadow;
    row.claimStatus = claim.status;
    records.set(key, row);
  }
  const confusion = Object.fromEntries(
    routes.map((expected) => [
      expected,
      Object.fromEntries(routes.map((actual) => [actual, 0])),
    ])
  );
  const seen = new Set();
  let matched = 0,
    correct = 0,
    unsafe = 0;
  for (const label of labels) {
    const id = JSON.stringify([label.runKey, label.eventIndex]);
    if (
      !routes.includes(label.expectedRoute) ||
      !Number.isSafeInteger(label.eventIndex) ||
      label.eventIndex < 0 ||
      typeof label.runKey !== 'string' ||
      seen.has(id)
    )
      throw new Error(
        'labels need a unique runKey/eventIndex and a known expectedRoute'
      );
    seen.add(id);
    const record = records.get(label.runKey);
    const candidate = record?.active?.candidate || record?.shadow;
    const index = record?.active?.candidate_ids
      ? record.active.candidate_ids.indexOf(
          record.active.event_ids?.[label.eventIndex]
        )
      : label.eventIndex;
    const result = candidate?.results?.find((row) => row.event_index === index);
    if (!routes.includes(result?.route)) continue;
    matched++;
    confusion[label.expectedRoute][result.route]++;
    if (result.route === label.expectedRoute) correct++;
    if (
      result.route === 'routine_result' &&
      label.expectedRoute !== 'routine_result'
    )
      unsafe++;
  }
  const candidates = [...records.values()].flatMap((row) =>
    [row.shadow, row.active?.candidate].filter(Boolean)
  );
  const results = candidates.flatMap((row) => row.results || []);
  const decided = results.filter((row) => row.source === 'decisions').length;
  const calls = candidates.filter(
    (row) =>
      row.request_started === true ||
      row.request_outcome_unknown === true ||
      row.status === 'pending' ||
      Number.isSafeInteger(row.input_tokens)
  );
  const unknownUsage = calls.filter(
    (row) => !Number.isSafeInteger(row.input_tokens)
  ).length;
  const input = calls.reduce((n, row) => n + (row.input_tokens || 0), 0);
  const cached = calls.reduce(
    (n, row) => n + (row.cached_input_tokens || 0),
    0
  );
  const written = calls.reduce(
    (n, row) => n + (row.cache_write_tokens || 0),
    0
  );
  const unknownWrites = calls.filter(
    (row) =>
      Number.isSafeInteger(row.input_tokens) &&
      !Number.isSafeInteger(row.cache_write_tokens)
  ).length;
  const unknownCached = calls.filter(
    (row) =>
      Number.isSafeInteger(row.input_tokens) &&
      !Number.isSafeInteger(row.cached_input_tokens)
  ).length;
  const durations = candidates
    .map((row) => row.duration_ms)
    .filter((n) => Number.isFinite(n) && n >= 0);
  const active = [...records.values()].filter((row) => row.active);
  const completed = active.filter((row) => row.claimStatus === 'succeeded');
  const shadowRuns = [...records.values()]
    .map((row) => row.shadow)
    .filter(Boolean);
  const previews = shadowRuns.map((row) => row.routing_preview).filter(Boolean);
  const previewDurations = previews
    .map((row) => row.duration_ms)
    .filter((n) => Number.isFinite(n) && n >= 0);
  const exclusions = new Map();
  for (const preview of previews) {
    for (const [reason, count] of Object.entries(preview.exclusions || {})) {
      if (
        /^[a-z][a-z_]{1,50}$/.test(reason) &&
        Number.isSafeInteger(count) &&
        count > 0
      )
        exclusions.set(reason, (exclusions.get(reason) || 0) + count);
    }
  }
  const periodic = periodicSummary(periodicLog);
  const suppressed =
    completed.filter((row) => row.active.suppressed === true).length +
    periodic.suppressedRuns;
  const ratesKnown = ['inputPerMillion', 'cachedInputPerMillion'].every(
    (key) => Number.isFinite(prices[key]) && prices[key] >= 0
  );
  const writeRateKnown =
    Number.isFinite(prices.cacheWritePerMillion) &&
    prices.cacheWritePerMillion >= 0;
  const decisionCost =
    ratesKnown &&
    !unknownUsage &&
    !unknownWrites &&
    (!written || writeRateKnown)
      ? ((input - cached - written) * prices.inputPerMillion +
          cached * prices.cachedInputPerMillion +
          written * (prices.cacheWritePerMillion || 0)) /
        1e6
      : null;
  const avoidedCost =
    Number.isFinite(prices.agentCallCost) && prices.agentCallCost >= 0
      ? suppressed * prices.agentCallCost
      : null;
  return {
    runs: records.size + periodic.runs,
    periodic,
    shadowRouting: {
      evaluatedBatches: previews.length,
      withoutPreview: shadowRuns.length - previews.length,
      batchesWithEligibleEvents: previews.filter(
        (row) => row.eligible_events > 0
      ).length,
      wouldSuppressBatches: previews.filter(
        (row) => row.would_suppress === true
      ).length,
      p50Ms: percentile(previewDurations, 0.5),
      p90Ms: percentile(previewDurations, 0.9),
      excludedEventsByReason: Object.fromEntries(exclusions),
    },
    classification: {
      samples: candidates.length,
      eventResults: results.length,
      decisionCoverage: results.length ? decided / results.length : null,
      completed: candidates.filter((row) => row.status === 'completed').length,
      fallbacks: candidates.filter((row) => row.status === 'fallback').length,
      timeouts: candidates.filter((row) => row.reason === 'timeout').length,
      calls: calls.length,
      inputTokens: input,
      cachedInputTokens: cached,
      cacheWriteTokens: written,
      unknownCacheWriteUsageCalls: unknownWrites,
      unknownUsageCalls: unknownUsage,
      unknownCachedUsageCalls: unknownCached,
      p50Ms: percentile(durations, 0.5),
      p90Ms: percentile(durations, 0.9),
    },
    quality: {
      labels: labels.length,
      matched,
      unmatched: labels.length - matched,
      accuracy: matched ? correct / matched : null,
      falseRoutine: unsafe,
      confusion,
    },
    delivery: {
      activeRuns: active.length + periodic.runs,
      completedRuns: completed.length + periodic.runs - periodic.unresolvedRuns,
      suppressedRuns: suppressed,
      agentAdmissions:
        completed.filter((row) => row.active.agent_admitted === true).length +
        periodic.agentAdmissions,
      unresolvedRuns:
        active.length - completed.length + periodic.unresolvedRuns,
    },
    estimates: {
      scope: periodic.available ? 'completion_and_periodic' : 'completion_only',
      decisionsCost: decisionCost,
      decisionsCostIsUpperBound: unknownCached > 0,
      avoidedAgentCost: avoidedCost,
      netSavings:
        decisionCost !== null && avoidedCost !== null
          ? avoidedCost - decisionCost
          : null,
      subscriptionCashSavings: null,
    },
  };
}
