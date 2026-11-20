#!/usr/bin/env node
// Usage: evaluate-autopilot-triage.mjs <triage.json> <inbox.json> [--min N] [--disable-via URL]
// <triage.json> is `GET /api/autopilot/triage`; <inbox.json> the Autopilot ledger.
// With --disable-via, rules that missed are switched off through that endpoint
// (for example the host proxy http://127.0.0.1:<port>/api/automation/autopilot/triage).
import { readFile } from 'node:fs/promises';
import { scoreTriage } from '../src/autopilot-triage.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args.splice(index, 2)[1] : undefined;
};
const min = Number(option('--min') ?? 300);
const disableVia = option('--disable-via');
const [triageFile, inboxFile] = args;
if (!triageFile || !inboxFile) {
  console.error('usage: evaluate-autopilot-triage.mjs <triage.json> <inbox.json> [--min N] [--disable-via URL]');
  process.exit(2);
}
const triage = JSON.parse(await readFile(triageFile, 'utf8'));
const inbox = JSON.parse(await readFile(inboxFile, 'utf8'));
const entries = Array.isArray(triage.entries)
  ? triage.entries
  : Object.entries(triage).map(([id, entry]) => ({ id, ...entry }));
const rules = scoreTriage(entries, inbox.items || {}, min);
const missed = Object.keys(rules).filter((rule) => rules[rule].acted > 0);
if (disableVia && missed.length) {
  const disabledRules = [...new Set([...(triage.disabledRules || []), ...missed])];
  const response = await fetch(disableVia, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disabledRules }),
  });
  if (!response.ok) throw new Error(`disabling ${missed.join(', ')} failed: ${response.status}`);
}
console.log(JSON.stringify({ mode: triage.mode, rules, disabled: disableVia ? missed : [] }, null, 2));
