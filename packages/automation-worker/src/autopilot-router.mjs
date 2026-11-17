import { evaluateAutopilotShadow } from './autopilot-routing.mjs';
import { reconcileAutopilot } from './autopilot-reconcile.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const identity = (item) =>
  JSON.stringify(
    item.notificationId
      ? [item.id, item.kind, item.notificationId, item.notificationRevision]
      : [item.id, item.kind, item.hostId, item.executionId]
  );
const uncertain = (retryable = false) =>
  Object.assign(
    new Error(
      '409 automation action is already running: result receipt is indeterminate'
    ),
    { indeterminate: true, retryable }
  );

// Classification cannot authorize an action; only the host's fresh, durable receipt can.
export async function routeAutopilot({
  event,
  record,
  persist,
  resolveHost,
  completeNotification,
  hydrateEvent,
  apiKey,
  minConfidence,
  allowNewActions = true,
  reconciliation,
  evaluate = evaluateAutopilotShadow,
}) {
  const items = [...(event.events || [event])];
  const ids = items.map(identity);
  if (
    reconciliation &&
    items.length === 1 &&
    items[0].kind === 'autopilot.reconcile'
  ) {
    const report = await reconcileAutopilot({
      ...reconciliation,
      record,
      persist,
    });
    return {
      report,
      remaining: report.changed ? items : [],
      handled: report.changed
        ? []
        : [
            {
              index: 0,
              item: items[0],
              source: 'rule',
              receipt: {
                action: 'autopilot_reconcile',
                status: 'recorded',
                fingerprint: report.fingerprint,
              },
            },
          ],
    };
  }
  if (record.outcome) {
    if (JSON.stringify(record.event_ids) !== JSON.stringify(ids))
      throw uncertain();
    return {
      remaining: record.outcome.remaining.map((index) => items[index]),
      handled: record.outcome.handled.map((row) => ({
        ...row,
        item: items[row.index],
      })),
    };
  }
  if (
    !Number.isFinite(minConfidence) ||
    minConfidence <= 0 ||
    minConfidence > 1
  )
    return { remaining: items, handled: [] };
  // User instructions, approvals and unknown event types take the prompt path immediately.
  if (
    items.some(
      (item) => !['process.completed', 'cloud.notification'].includes(item.kind)
    )
  )
    return { remaining: items, handled: [] };
  const remaining = new Set();
  const handled = [];
  const eligible = [];
  const hosts = new Map();
  const started = Date.now();
  const controller = new AbortController();
  const deadline = () => {
    if (Date.now() - started >= 3000) controller.abort();
    controller.signal.throwIfAborted();
  };
  const within = async (call) => {
    deadline();
    let timer;
    try {
      return await Promise.race([
        call(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new Error('routing timeout'));
            },
            Math.max(1, 3000 - (Date.now() - started))
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const hostFor = async (item) => {
    if (!hosts.has(item.hostId))
      hosts.set(
        item.hostId,
        within(() => resolveHost(item.hostId, controller.signal))
      );
    return hosts.get(item.hostId);
  };
  const accept = async (index, item, receipt, source) => {
    if (item.notificationClaim) {
      record.cloud_attempted = [
        ...new Set([...(record.cloud_attempted || []), ids[index]]),
      ];
      await within(persist);
      let completed;
      try {
        completed = await within(() => completeNotification(item, receipt));
      } catch {
        throw uncertain(true);
      }
      if (!completed) {
        remaining.add(index);
        return;
      }
    }
    handled.push({ index, item, receipt, source });
  };
  try {
    for (let index = 0; index < items.length; index++) {
      let item = items[index];
      if (
        index < 8 &&
        item.kind === 'cloud.notification' &&
        item.notificationClaim &&
        hydrateEvent
      ) {
        try {
          item = items[index] = record.bindings?.[ids[index]]
            ? { ...item, ...record.bindings[ids[index]] }
            : await within(() => hydrateEvent(item, controller.signal));
          (record.bindings ||= {})[ids[index]] = {
            hostId: item.hostId,
            workspaceId: item.workspaceId,
            executionId: item.executionId,
          };
          // Keep the fresh in-memory token on the request; persist only its lease identity.
          items[index] = item;
        } catch {
          if (record.cloud_attempted?.includes(ids[index]))
            throw uncertain(true);
          remaining.add(index);
          continue;
        }
      }
      if (
        index >= 8 ||
        !UUID.test(item.executionId) ||
        !UUID.test(item.hostId)
      ) {
        remaining.add(index);
        continue;
      }
      try {
        const host = await hostFor(item);
        const path = `/api/automation-actions/autopilot-results/${item.executionId}`;
        const guard = await within(() => host.get(path, controller.signal));
        if (
          guard.hostId !== host.machineId ||
          guard.execution_id !== item.executionId ||
          (item.workspaceId && guard.workspace_id !== item.workspaceId)
        )
          throw new Error('host evidence mismatch');
        if (
          guard.receipt?.action === 'autopilot_result' &&
          guard.receipt.execution_id === item.executionId &&
          guard.receipt.status === 'recorded'
        ) {
          await accept(index, item, guard.receipt, 'rule');
        } else if (
          !allowNewActions &&
          !record.attempted?.includes(ids[index])
        ) {
          remaining.add(index);
        } else if (
          guard.eligible === true &&
          typeof guard.version === 'string' &&
          typeof guard.result_hash === 'string'
        ) {
          eligible.push({ index, item, guard, host, path });
        } else {
          if (record.attempted?.includes(ids[index])) throw uncertain(true);
          remaining.add(index);
        }
      } catch (error) {
        if (error.indeterminate) throw error;
        if (
          record.attempted?.includes(ids[index]) ||
          record.cloud_attempted?.includes(ids[index])
        )
          throw uncertain(true);
        remaining.add(index);
      }
    }
    if (eligible.length) {
      if (!record.candidate) {
        record.candidate = { status: 'pending' };
        record.candidate_ids = eligible.map(({ index }) => ids[index]);
        await within(persist);
        record.candidate = await within(() =>
          evaluate({
            event: {
              events: eligible.map(({ item }) => ({
                ...item,
                kind: 'process.completed',
              })),
            },
            apiKey,
            timeoutMs: Math.max(1, 3000 - (Date.now() - started)),
            resolveMachineId: async (id) =>
              (await hostFor({ hostId: id })).machineId,
            readHost: async (item, path, signal) =>
              (await hostFor(item)).get(path, signal),
          })
        );
        await within(persist);
      }
      for (const entry of eligible) {
        const { index, item, host, guard, path } = entry;
        const candidate = record.candidate;
        const candidateIndex = record.candidate_ids?.indexOf(ids[index]);
        const result = candidate.results?.find(
          (row) => row.event_index === candidateIndex
        );
        if (
          candidate.status !== 'completed' ||
          result?.source !== 'decisions' ||
          result.route !== 'routine_result' ||
          result.truncated !== false ||
          !Number.isFinite(result.confidence) ||
          result.confidence > 1 ||
          result.confidence < minConfidence ||
          result.evidence_hash !== guard.result_hash
        ) {
          if (record.attempted?.includes(ids[index])) throw uncertain();
          remaining.add(index);
          continue;
        }
        record.attempted = [
          ...new Set([...(record.attempted || []), ids[index]]),
        ];
        await within(persist);
        let receipt;
        try {
          receipt = await within(() =>
            host.post(
              path,
              { version: guard.version, result_hash: guard.result_hash },
              controller.signal
            )
          );
        } catch (error) {
          if (
            !(error.status >= 400 && error.status < 500) ||
            /already running/i.test(error.message)
          )
            throw uncertain(true);
          remaining.add(index);
          continue;
        }
        if (
          receipt?.action !== 'autopilot_result' ||
          receipt.status !== 'recorded' ||
          receipt.execution_id !== item.executionId ||
          receipt.result_hash !== guard.result_hash
        )
          throw uncertain(true);
        try {
          await accept(index, item, receipt, 'decisions');
        } catch (error) {
          throw error.indeterminate ? error : uncertain(true);
        }
      }
    }
  } catch (error) {
    if (error.indeterminate) throw error;
    for (const { index } of eligible)
      if (!handled.some((row) => row.index === index)) remaining.add(index);
    // An unavailable collector must never silently consume an unvisited event.
    for (let index = 0; index < items.length; index++)
      if (!handled.some((row) => row.index === index)) remaining.add(index);
  } finally {
    controller.abort();
  }
  record.event_ids = ids;
  record.outcome = {
    remaining: [...remaining].sort((a, b) => a - b),
    handled: handled.map(({ item: _, ...row }) => row),
  };
  // Freeze agent-vs-handled disposition before an agent admission can occur.
  await persist();
  return {
    remaining: record.outcome.remaining.map((index) => items[index]),
    handled,
  };
}
