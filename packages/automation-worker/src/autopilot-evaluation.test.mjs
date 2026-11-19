import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { evaluateAutopilotRecords } from './autopilot-evaluation.mjs';

test('quality detects false routine classifications and keeps unmatched labels out of accuracy', () => {
  const report = evaluateAutopilotRecords({ observations: {}, claims: {} });
  assert.equal(report.quality.accuracy, null);
  const result = evaluateAutopilotRecords({
    observations: {
      sample: {
        status: 'completed',
        request_started: true,
        input_tokens: 1000,
        cached_input_tokens: 200,
        cache_write_tokens: 0,
        duration_ms: 30,
        results: [{ event_index: 0, route: 'routine_result' }],
      },
    },
    labels: [
      { runKey: 'sample', eventIndex: 0, expectedRoute: 'needs_investigation' },
      { runKey: 'unknown', eventIndex: 0, expectedRoute: 'needs_user' },
    ],
    prices: { inputPerMillion: 2, cachedInputPerMillion: 1 },
  });
  assert.equal(result.quality.falseRoutine, 1);
  assert.equal(result.quality.accuracy, 0);
  assert.equal(result.quality.unmatched, 1);
  assert.equal(result.estimates.decisionsCost, 0.0018);
  assert.equal(result.estimates.subscriptionCashSavings, null);
});

test('only completed suppressed runs contribute avoided agent cost; missing usage is unknown', () => {
  const result = evaluateAutopilotRecords({
    claims: {
      done: {
        status: 'succeeded',
        autopilotRouting: {
          suppressed: true,
          candidate: { status: 'fallback', request_started: true },
        },
      },
      retry: { status: 'retrying', autopilotRouting: { suppressed: true } },
      agent: {
        status: 'succeeded',
        autopilotRouting: { agent_admitted: true, suppressed: false },
      },
    },
    prices: {
      inputPerMillion: 1,
      cachedInputPerMillion: 1,
      agentCallCost: 0.25,
    },
  });
  assert.equal(result.delivery.suppressedRuns, 1);
  assert.equal(result.delivery.agentAdmissions, 1);
  assert.equal(result.delivery.unresolvedRuns, 1);
  assert.equal(result.estimates.avoidedAgentCost, 0.25);
  assert.equal(result.estimates.decisionsCost, null);
});

test('duplicate human labels cannot inflate measured quality', () => {
  const label = {
    runKey: 'sample',
    eventIndex: 0,
    expectedRoute: 'routine_result',
  };
  assert.throws(() => evaluateAutopilotRecords({ labels: [label, label] }));
});

test('shadow predictions are separate from observed suppression and legacy records remain unmeasured', () => {
  const evaluation = evaluateAutopilotRecords({
    observations: {
      legacy: { results: [{ route: 'routine_result', confidence: 0.99 }] },
      qualified: {
        routing_preview: { eligible_events: 1, would_suppress: true },
      },
      mixed: {
        routing_preview: {
          eligible_events: 1,
          would_suppress: false,
          exclusions: { timeout: 1 },
        },
      },
      protected: {
        routing_preview: {
          eligible_events: 0,
          would_suppress: false,
          exclusions: { protected_batch: 2 },
        },
      },
      elapsed: { status: 'fallback', request_outcome_unknown: true },
    },
    prices: { inputPerMillion: 1, cachedInputPerMillion: 1, agentCallCost: 5 },
  });
  assert.deepEqual(evaluation.shadowRouting, {
    evaluatedBatches: 3,
    withoutPreview: 2,
    batchesWithEligibleEvents: 2,
    wouldSuppressBatches: 1,
    excludedEventsByReason: { timeout: 1, protected_batch: 2 },
  });
  assert.equal(evaluation.estimates.avoidedAgentCost, 0);
  assert.equal(evaluation.estimates.decisionsCost, null);
});

test('cache writes are billed separately and missing write usage is not counted as a saving', () => {
  const sample = {
    request_started: true,
    status: 'completed',
    input_tokens: 1000,
    cached_input_tokens: 200,
    cache_write_tokens: 100,
  };
  const prices = {
    inputPerMillion: 2,
    cachedInputPerMillion: 1,
    cacheWritePerMillion: 3,
  };
  assert.equal(
    evaluateAutopilotRecords({ observations: { sample }, prices }).estimates
      .decisionsCost,
    0.0019
  );
  delete sample.cache_write_tokens;
  assert.equal(
    evaluateAutopilotRecords({ observations: { sample }, prices }).estimates
      .decisionsCost,
    null
  );
});

test('periodic gate logs count finalized skips and deduplicate admissions without counting holds', () => {
  const at = '2002-03-04T00:00:00Z';
  const skip = (evidence, ms) => ({
    at,
    ms,
    periodic: { status: 'handled', source: 'code', evidence },
  });
  const rows = [
    skip('synthetic-proof-a', 100),
    skip('synthetic-proof-a', 999),
    skip('synthetic-proof-b', 200),
    skip('synthetic-proof-c', 300),
    { at, periodic: { status: 'uncertain', id: 'synthetic-task' } },
    { at, ms: 400, periodic: { status: 'queued', id: 'synthetic-task' } },
    { at, ms: 999, periodic: { status: 'started', id: 'synthetic-task' } },
    { at, periodic: { status: 'in_flight', id: 'synthetic-task' } },
    {
      at,
      periodic: {
        status: 'blocked',
        id: 'synthetic-blocked',
        system_one_fallback: 'scope_mismatch',
      },
    },
    { at, periodic: { status: 'would_delegate' } },
  ];
  const report = evaluateAutopilotRecords({
    periodicLog: rows,
    prices: {
      agentCallCost: 0.25,
      inputPerMillion: 1,
      cachedInputPerMillion: 1,
    },
  });
  assert.equal(report.runs, 4);
  assert.equal(report.delivery.activeRuns, 4);
  assert.equal(report.delivery.completedRuns, 4);
  assert.equal(report.delivery.suppressedRuns, 3);
  assert.equal(report.delivery.agentAdmissions, 1);
  assert.equal(report.periodic.unresolvedRuns, 0);
  assert.deepEqual(report.periodic.fallbackAttemptsByReason, {
    scope_mismatch: 1,
  });
  assert.equal(report.periodic.gateP50Ms, 200);
  assert.equal(report.periodic.gateP90Ms, 400);
  assert.equal(report.estimates.avoidedAgentCost, 0.75);
  assert.equal(report.estimates.scope, 'completion_and_periodic');
  assert.equal(evaluateAutopilotRecords({}).periodic.available, false);
  const unresolved = evaluateAutopilotRecords({
    periodicLog: [
      { at, periodic: { status: 'uncertain', id: 'synthetic-unknown' } },
    ],
  });
  assert.equal(unresolved.delivery.activeRuns, 1);
  assert.equal(unresolved.delivery.completedRuns, 0);
  assert.equal(unresolved.delivery.unresolvedRuns, 1);
  assert.equal(unresolved.delivery.agentAdmissions, 0);
});

test('the evaluator CLI reads periodic JSONL and rejects malformed input without exposing it', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'synthetic-evaluation-'));
  const log = path.join(folder, 'gate.jsonl');
  const prices = path.join(folder, 'prices.json');
  const cli = new URL('../scripts/evaluate-autopilot.mjs', import.meta.url);
  const run = () =>
    spawnSync(
      process.execPath,
      [fileURLToPath(cli), '-', '-', '-', prices, log],
      { encoding: 'utf8' }
    );
  try {
    await writeFile(prices, JSON.stringify({ agentCallCost: 0.25 }));
    await writeFile(
      log,
      [1, 2, 3]
        .map((number) =>
          JSON.stringify({
            at: '2002-03-04T00:00:00Z',
            ms: number * 100,
            periodic: {
              status: 'handled',
              source: 'code',
              evidence: `synthetic-proof-${number}`,
            },
          })
        )
        .join('\n')
    );
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.periodic.suppressedRuns, 3);
    assert.equal(report.estimates.avoidedAgentCost, 0.75);
    await writeFile(log, 'synthetic-private-invalid-json');
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.ok(!invalid.stderr.includes('synthetic-private-invalid-json'));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
