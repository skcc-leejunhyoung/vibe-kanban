import assert from 'node:assert/strict';
import test from 'node:test';
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
