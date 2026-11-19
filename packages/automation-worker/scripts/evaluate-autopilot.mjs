#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { evaluateAutopilotRecords } from '../src/autopilot-evaluation.mjs';

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
const read = async (path, fallback) =>
  path ? JSON.parse(await readFile(path, 'utf8')) : fallback;
if (!args[0] || args.includes('--help')) {
  console.log(
    'node scripts/evaluate-autopilot.mjs STATE_JSON OBSERVATIONS_JSON LABELS_JSON PRICES_JSON [AP_GATE_JSONL]\nOptional files use -; prices: inputPerMillion, cachedInputPerMillion, cacheWritePerMillion, agentCallCost. Labels: runKey, eventIndex, expectedRoute.'
  );
} else {
  const [state, observations, labels, prices] = await Promise.all(
    args
      .slice(0, 4)
      .map((value, index) =>
        read(value === '-' ? undefined : value, index === 2 ? [] : {})
      )
  );
  console.log(
    JSON.stringify(
      evaluateAutopilotRecords({
        claims: state?.routineClaims,
        observations,
        labels,
        prices,
        periodicLog: await readPeriodicLog(args[4]),
      }),
      null,
      2
    )
  );
}
