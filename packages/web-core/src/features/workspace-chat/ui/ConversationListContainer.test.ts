import { produce } from 'immer';
import { expect, it, vi } from 'vitest';
import type {
  NormalizedEntryType,
  PatchType,
  ExecutionProcess,
  ExecutorAction,
} from 'shared/types';
import { BaseCodingAgent, ExecutionProcessStatus } from 'shared/types';
import type {
  ConversationTimelineSource,
  DisplayEntry,
} from '@/shared/hooks/useConversationHistory/types';
import type { ConversationRow } from '../model/conversation-row-model';
import { applyUpsertPatch } from '@/shared/lib/jsonPatch';
import {
  patchWithKey,
  latestConversationEntry,
} from '../model/hooks/useConversationHistory';
import * as entryDerivation from '../model/deriveConversationEntries';
import { deriveConversationTimeline } from '../model/deriveConversationTimeline';
import { createConversationDerivation } from './ConversationListContainer';

vi.mock('./DisplayConversationEntry', () => ({ default: () => null }));
vi.mock('./ArtifactCards', () => ({ ExecutionArtifactResults: () => null }));
vi.mock('@/shared/dialogs/scripts/ScriptFixerDialog', () => ({
  ScriptFixerDialog: {},
}));
vi.mock('../model/hooks/useResetProcess', () => ({ useResetProcess: vi.fn() }));

function entry(
  type: NormalizedEntryType = { type: 'assistant_message' },
  content = 'text'
): PatchType {
  return {
    type: 'NORMALIZED_ENTRY',
    content: { entry_type: type, content, timestamp: null },
  };
}
const read = () =>
  entry({
    type: 'tool_use',
    tool_name: 'Read',
    action_type: { action: 'file_read', path: 'a.ts' },
    status: { status: 'success' },
  });
const edit = () =>
  entry({
    type: 'tool_use',
    tool_name: 'Edit',
    action_type: { action: 'file_edit', path: 'a.ts', changes: [] },
    status: { status: 'success' },
  });
const pending = () =>
  entry({
    type: 'tool_use',
    tool_name: 'Read',
    action_type: { action: 'file_read', path: 'approval.ts' },
    status: {
      status: 'pending_approval',
      approval_id: 'approval',
    },
  });
const token = () =>
  entry({
    type: 'token_usage_info',
    total_tokens: 12,
    model_context_window: 100,
  });
const action = (prompt: string): ExecutorAction => ({
  typ: {
    type: 'CodingAgentFollowUpRequest',
    prompt,
    session_id: 'session',
    executor_config: { executor: BaseCodingAgent.CLAUDE_CODE },
    reset_to_message_id: null,
    working_dir: null,
  },
  next_action: null,
});
function makeProcess(
  id: string,
  index: number,
  executorAction = action(id)
): ExecutionProcess {
  return {
    id,
    session_id: 'session',
    run_reason: 'codingagent',
    executor_action: executorAction,
    status: ExecutionProcessStatus.completed,
    exit_code: 0n,
    dropped: false,
    started_at: '',
    completed_at: null,
    created_at: new Date(index * 1000).toISOString(),
    updated_at: '',
  };
}
function sourceOf(
  records: Array<[ExecutionProcess, PatchType[]]>
): ConversationTimelineSource {
  return {
    liveExecutionProcesses: records.map(([p]) => p),
    executionProcessState: Object.fromEntries(
      records.map(([p, entries]) => [
        p.id,
        {
          executionProcess: p,
          entries: entries.map((e, i) => patchWithKey(e, p.id, i)),
        },
      ])
    ),
  };
}
function replaceRaw(
  source: ConversationTimelineSource,
  id: string,
  raw: PatchType[]
) {
  source.executionProcessState[id] = {
    ...source.executionProcessState[id],
    entries: raw.map((e, i) => patchWithKey(e, id, i)),
  };
}
function baseline() {
  const scriptOutputCache = new Map<
    string,
    { count: number; output: string }
  >();
  let previousEntries: DisplayEntry[] = [];
  let previousRows: ConversationRow[] = [];
  return (source: ConversationTimelineSource) => {
    const derived = entryDerivation.deriveConversationEntries({
      source,
      scriptOutputCache,
    });
    const timeline = deriveConversationTimeline(
      derived.entries,
      previousEntries,
      previousRows
    );
    previousEntries = timeline.displayEntries;
    previousRows = timeline.rows;
    return { ...derived, ...timeline };
  };
}

it('keeps immutable patch references, including nested updates, upserts and reindexing', () => {
  const initial = { entries: [entry(), read(), token()] };
  const before = initial.entries.map((e, i) => patchWithKey(e, 'p', i));
  const after = produce(initial, (draft) =>
    applyUpsertPatch(draft, [
      { op: 'replace', path: '/entries/1/content/content', value: 'changed' },
      { op: 'replace', path: '/entries/3', value: entry() },
    ])
  );
  const keyed = after.entries.map((e, i) => patchWithKey(e, 'p', i));
  expect(keyed[0]).toBe(before[0]);
  expect(keyed[1]).not.toBe(before[1]);
  expect(keyed[2]).toBe(before[2]);
  expect(after.entries).toHaveLength(4);
  const shifted = produce(after, (draft) =>
    applyUpsertPatch(draft, [{ op: 'remove', path: '/entries/0' }])
  );
  expect(patchWithKey(shifted.entries[1], 'p', 1).patchKey).toBe('p:1');
  expect(
    patchWithKey(shifted.entries[1], 'other-host-process', 1).executionProcessId
  ).toBe('other-host-process');
  expect(before[0].content).toEqual(initial.entries[0].content);
});

it('matches the previous latest-entry order for empty processes, timestamp ties and older inserts', () => {
  const source = sourceOf([
    [makeProcess('new', 2), [read()]],
    [makeProcess('old', 1), [entry()]],
    [makeProcess('tie', 2), [token()]],
    [makeProcess('empty', 3), []],
  ]);
  const expected = Object.values(source.executionProcessState)
    .sort(
      (a, b) =>
        Date.parse(a.executionProcess.created_at) -
        Date.parse(b.executionProcess.created_at)
    )
    .flatMap((p) => p.entries)
    .at(-1);
  expect(latestConversationEntry(source.executionProcessState)).toBe(expected);
  expect(latestConversationEntry({})).toBeUndefined();
});

it('matches full output snapshots across streaming, cross-process groups, approvals, scripts, paging and reset', () => {
  const initialAction: ExecutorAction = {
    typ: {
      type: 'CodingAgentInitialRequest',
      prompt: 'initial',
      executor_config: { executor: BaseCodingAgent.CLAUDE_CODE },
      working_dir: null,
      handoff_from: null,
      handoff_session_id: null,
      handoff_user_prompt: null,
    },
    next_action: null,
  };
  const setupAction: ExecutorAction = {
    typ: {
      type: 'ScriptRequest',
      script: 'setup',
      language: 'Bash',
      context: 'SetupScript',
      working_dir: null,
    },
    next_action: initialAction,
  };
  const setup = makeProcess('setup', 0, setupAction);
  const first = makeProcess('first', 1, initialAction);
  const second = makeProcess('second', 2, action(''));
  const last = makeProcess('last', 3);
  last.status = ExecutionProcessStatus.running;
  const source = sourceOf([
    [
      last,
      [
        entry({ type: 'thinking' }),
        read(),
        read(),
        edit(),
        edit(),
        entry(),
        token(),
      ],
    ],
    [first, [entry({ type: 'thinking' }), read()]],
    [second, [read(), entry({ type: 'thinking' })]],
    [setup, [{ type: 'STDOUT', content: 'setup output' }]],
  ]);
  const full = baseline();
  const incremental = createConversationDerivation();
  const compare = () => {
    const expected = full(source);
    const actual = incremental(source);
    // Full serialized row payloads, group membership, keys and global state.
    expect(JSON.parse(JSON.stringify(actual))).toEqual(
      JSON.parse(JSON.stringify(expected))
    );
    return actual;
  };
  compare();
  const previous = compare();
  replaceRaw(source, 'last', [
    entry({ type: 'thinking' }),
    read(),
    read(),
    edit(),
    edit(),
    entry(undefined, 'streamed'),
    token(),
  ]);
  const updated = compare();
  const stable = previous.rows.filter((row) => row.processId !== 'last');
  expect(
    stable.every(
      (row) =>
        updated.rows.find((r) => r.semanticKey === row.semanticKey) === row
    )
  ).toBe(true);
  replaceRaw(source, 'last', [pending(), token()]);
  compare();
  source.liveExecutionProcesses = source.liveExecutionProcesses.map((p) =>
    p.id === 'last'
      ? { ...p, status: ExecutionProcessStatus.failed, exit_code: 1n }
      : p
  );
  replaceRaw(source, 'last', [
    entry(
      { type: 'error_message', error_type: { type: 'setup_required' } },
      'install helper'
    ),
    token(),
  ]);
  compare();
  replaceRaw(source, 'setup', [
    { type: 'STDOUT', content: 'setup output' },
    { type: 'STDERR', content: 'warning' },
  ]);
  compare();
  const historic = makeProcess('historic', -1);
  source.executionProcessState.historic = sourceOf([
    [historic, [entry({ type: 'thinking' })]],
  ]).executionProcessState.historic;
  source.liveExecutionProcesses.push(historic);
  compare();
  delete source.executionProcessState.setup;
  compare();
  delete source.executionProcessState.last;
  compare();
  source.executionProcessState = {};
  source.liveExecutionProcesses = [];
  compare();
  const nextSession = sourceOf([
    [makeProcess('first', 1), [entry(undefined, 'new session')]],
  ]);
  expect(incremental(nextSession)).toEqual(full(nextSession));
});

it('does not rescan completed raw entries and reuses unchanged active groups', () => {
  const active = makeProcess('active', 2);
  active.status = ExecutionProcessStatus.running;
  const raw = [
    entry({ type: 'thinking' }),
    read(),
    read(),
    edit(),
    edit(),
    entry(),
  ];
  const source = sourceOf([
    [makeProcess('done', 1), [read(), token()]],
    [active, raw],
  ]);
  const derive = createConversationDerivation();
  const before = derive(source);
  const spy = vi.spyOn(entryDerivation, 'deriveConversationEntries');
  replaceRaw(source, 'active', [
    ...raw.slice(0, -1),
    entry(undefined, 'update'),
  ]);
  const after = derive(source);
  const doneSource =
    spy.mock.calls[0][0].source.executionProcessState.done.entries;
  expect(doneSource).toHaveLength(1);
  expect(doneSource[0]).toBe(source.executionProcessState.done.entries[1]);
  for (const row of before.rows.filter(
    (r) =>
      r.rowFamily === 'aggregated_tool' ||
      r.rowFamily === 'aggregated_diff' ||
      r.isUserMessage ||
      r.rowFamily === 'loading'
  )) {
    expect(after.rows.find((r) => r.semanticKey === row.semanticKey)).toBe(row);
  }
  spy.mockRestore();
});

it('matches full derivation when groups grow, split, shrink or change inside a cached prefix', () => {
  const active = makeProcess('active', 3);
  active.status = ExecutionProcessStatus.running;
  let raw: PatchType[] = [
    entry(),
    read(),
    read(),
    entry({ type: 'thinking' }),
    entry(),
  ];
  const source = sourceOf([
    [makeProcess('first', 1), [entry({ type: 'thinking' })]],
    [makeProcess('no-prompt', 2, action('')), [read()]],
    [active, raw],
  ]);
  const full = baseline();
  const incremental = createConversationDerivation();
  const kinds = [
    read,
    edit,
    () => entry({ type: 'thinking' }),
    () => entry(),
    pending,
    token,
  ];
  for (let i = 0; i < 90; i++) {
    const next = kinds[i % kinds.length]();
    if (i % 3 === 0) raw = [...raw, next];
    else if (i % 3 === 1)
      raw = raw.map((e, index) => (index === (i * 7) % raw.length ? next : e));
    else raw = raw.filter((_, index) => index !== (i * 11) % raw.length);
    replaceRaw(source, 'active', raw);
    expect(incremental(source)).toEqual(full(source));
  }
});

// Repeatable CPU profile of one frame, including rekeying and latest-entry
// lookup; transport/Immer application and React/DOM rendering are excluded.
// Run alone: SKC_4776_PROFILE=1 pnpm --filter @vibe/web-core test ConversationListContainer.test.ts
// Profile at frame cadence, with baseline and optimized runs separated. Strict
// mode checks every measured frame; ordinary suite runs only check correctness.
for (const processCount of [1, 20]) {
  it(`profiles 2,000 entries (${processCount} processes), preserving output and row identity`, async () => {
    const perProcess = 2000 / processCount;
    const records: Array<[ExecutionProcess, PatchType[]]> = Array.from(
      { length: processCount },
      (_, p) => {
        const proc = makeProcess(`p${p}`, p);
        if (p === processCount - 1)
          proc.status = ExecutionProcessStatus.running;
        return [
          proc,
          Array.from({ length: perProcess }, (_, i) =>
            i % 10 === 1 || i % 10 === 2
              ? read()
              : i % 10 === 3 || i % 10 === 4
                ? edit()
                : i % 10 === 5
                  ? entry({ type: 'thinking' })
                  : entry(undefined, `entry ${p}:${i}`)
          ),
        ];
      }
    );
    const [active, initialRaw] = records.at(-1)!;
    const profile = Boolean(globalThis.process.env.SKC_4776_PROFILE);
    const measure = async (incremental: boolean) => {
      const source = sourceOf(records);
      const derive = incremental ? createConversationDerivation() : baseline();
      let result = derive(source);
      let previous = result;
      const samples: number[] = [];
      for (let i = 0; i < 240; i++) {
        if (profile) await new Promise((resolve) => setTimeout(resolve, 16));
        const raw = [
          ...initialRaw.slice(0, -1),
          entry(undefined, `chunk ${i}`),
        ];
        previous = result;
        const start = performance.now();
        if (incremental) {
          replaceRaw(source, active.id, raw);
          latestConversationEntry(source.executionProcessState);
        } else {
          source.executionProcessState[active.id] = {
            executionProcess: active,
            entries: raw.map((e, index) => ({
              ...e,
              patchKey: `${active.id}:${index}`,
              executionProcessId: active.id,
            })),
          };
          Object.values(source.executionProcessState)
            .sort(
              (a, b) =>
                Date.parse(a.executionProcess.created_at) -
                Date.parse(b.executionProcess.created_at)
            )
            .flatMap((p) => p.entries)
            .at(-1);
        }
        result = derive(source);
        const elapsed = performance.now() - start;
        if (i >= 40) samples.push(elapsed);
      }
      const previousRows = new Map(
        previous.rows.map((row) => [row.semanticKey, row])
      );
      const unchanged = result.rows.filter(
        (row) => row.entry.patchKey !== `${active.id}:${perProcess - 1}`
      );
      const reuse =
        unchanged.filter((row) => previousRows.get(row.semanticKey) === row)
          .length / unchanged.length;
      samples.sort((a, b) => a - b);
      return {
        result,
        reuse,
        maxMs: samples.at(-1)!,
        stats: {
          medianMs: +samples[100].toFixed(3),
          p95Ms: +samples[190].toFixed(3),
          maxMs: +samples.at(-1)!.toFixed(3),
          overBudgetFrames: samples.filter((ms) => ms >= 2).length,
        },
      };
    };
    const before = await measure(false);
    const after = await measure(true);
    expect(after.result).toEqual(before.result);
    expect(after.reuse).toBe(1);
    console.info(
      'SKC-4776',
      JSON.stringify({
        entries: 2000,
        processes: processCount,
        samples: 200,
        cadenceMs: profile ? 16 : 0,
        before: before.stats,
        after: after.stats,
        beforeReuse: before.reuse,
        afterReuse: after.reuse,
      })
    );
    if (profile) expect(after.maxMs).toBeLessThan(2);
  }, 20_000);
}
