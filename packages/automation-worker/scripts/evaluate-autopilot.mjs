#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { periodicSummary } from '../src/autopilot-evaluation.mjs';

const args = process.argv.slice(2);
async function readPeriodicLog(file) {
  const result = [];
  if (!file || file === '-') return undefined;
  let lineNumber = 0;
  for await (const line of createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  })) {
    lineNumber++;
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Invalid gate log JSON at line ${lineNumber}`);
    }
    if (row?.periodic) {
      const item = row.periodic;
      result.push({
        at: row.at,
        ms: row.ms,
        periodic: {
          id: item.id,
          status: item.status,
          source: item.source,
          evidence: item.evidence,
          system_one_fallback: item.system_one_fallback,
        },
      });
    }
  }
  return result;
}
if (!args[0] || args.includes('--help')) {
  console.log('node scripts/evaluate-autopilot.mjs AP_GATE_JSONL');
} else {
  console.log(
    JSON.stringify(periodicSummary(await readPeriodicLog(args[0])), null, 2)
  );
}
