import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { periodicSummary } from './autopilot-evaluation.mjs';

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
  const report = periodicSummary(rows);
  assert.equal(report.available, true);
  assert.equal(report.runs, 4);
  assert.equal(report.suppressedRuns, 3);
  assert.equal(report.agentAdmissions, 1);
  assert.equal(report.unresolvedRuns, 0);
  assert.deepEqual(report.fallbackAttemptsByReason, {
    scope_mismatch: 1,
  });
  assert.equal(report.gateP50Ms, 200);
  assert.equal(report.gateP90Ms, 400);
  assert.equal(periodicSummary(undefined).available, false);
  const unresolved = periodicSummary([
    { at, periodic: { status: 'uncertain', id: 'synthetic-unknown' } },
  ]);
  assert.equal(unresolved.runs, 1);
  assert.equal(unresolved.unresolvedRuns, 1);
  assert.equal(unresolved.agentAdmissions, 0);
});

test('the evaluator CLI reads periodic JSONL and rejects malformed input without exposing it', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'synthetic-evaluation-'));
  const log = path.join(folder, 'gate.jsonl');
  const cli = new URL('../scripts/evaluate-autopilot.mjs', import.meta.url);
  const run = () =>
    spawnSync(process.execPath, [fileURLToPath(cli), log], {
      encoding: 'utf8',
    });
  try {
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
    assert.equal(report.suppressedRuns, 3);
    await writeFile(log, 'synthetic-private-invalid-json');
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.ok(!invalid.stderr.includes('synthetic-private-invalid-json'));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
