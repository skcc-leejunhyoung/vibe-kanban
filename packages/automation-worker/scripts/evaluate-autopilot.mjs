#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { evaluateAutopilotRecords } from '../src/autopilot-evaluation.mjs';

const args = process.argv.slice(2);
const read = async (path, fallback) =>
  path ? JSON.parse(await readFile(path, 'utf8')) : fallback;
if (!args[0] || args.includes('--help')) {
  console.log(
    'node scripts/evaluate-autopilot.mjs STATE_JSON OBSERVATIONS_JSON LABELS_JSON PRICES_JSON\nOptional files use -; prices: inputPerMillion, cachedInputPerMillion, cacheWritePerMillion, agentCallCost. Labels: runKey, eventIndex, expectedRoute.'
  );
} else {
  const [state, observations, labels, prices] = await Promise.all(
    args.map((value, index) =>
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
      }),
      null,
      2
    )
  );
}
