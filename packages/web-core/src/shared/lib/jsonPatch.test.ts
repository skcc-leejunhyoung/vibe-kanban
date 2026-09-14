import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import type { Operation } from 'rfc6902';
import { applyUpsertPatch, applyUpsertPatchBatch } from './jsonPatch';

describe('applyUpsertPatchBatch', () => {
  const cases: { name: string; ops: Operation[]; expected: object }[] = [
    {
      name: 'does not insert when replacing an existing array element',
      ops: [{ op: 'replace', path: '/entries/0', value: 'replaced' }],
      expected: { entries: ['replaced'], map: {} },
    },
    {
      name: 'continues after missing-remove and failed-test errors',
      ops: [
        { op: 'add', path: '/entries/-', value: 'before' },
        { op: 'remove', path: '/missing' },
        { op: 'test', path: '/entries/0', value: 'wrong' },
        { op: 'add', path: '/entries/-', value: 'after' },
      ],
      expected: { entries: ['first', 'before', 'after'], map: {} },
    },
    {
      name: 'upserts before dependent operations without duplicating array adds',
      ops: [
        { op: 'add', path: '/entries/-', value: 'once' },
        { op: 'replace', path: '/map/new', value: { child: 1 } },
        { op: 'replace', path: '/map/new/child', value: 2 },
        { op: 'copy', from: '/map/new', path: '/map/copy' },
        { op: 'remove', path: '/map/new' },
        { op: 'replace', path: '/entries/2', value: 'tail' },
      ],
      expected: {
        entries: ['first', 'once', 'tail'],
        map: { copy: { child: 2 } },
      },
    },
    {
      name: 'preserves escaped pointers and does not create missing parents',
      ops: [
        { op: 'replace', path: '/map/a~1b', value: { '~key': 1 } },
        { op: 'replace', path: '/map/a~1b/~0key', value: 2 },
        { op: 'replace', path: '/absent/child', value: 3 },
      ],
      expected: { entries: ['first'], map: { 'a/b': { '~key': 2 } } },
    },
  ];

  it.each(cases)('$name', ({ ops, expected }) => {
    const original = { entries: ['first'], map: {} };
    const sequential = produce(original, (draft) =>
      applyUpsertPatch(draft, ops)
    );
    const { data: result } = applyUpsertPatchBatch(original, [ops]);
    expect(result).toEqual(expected);
    expect(result).toEqual(sequential);
    expect(original).toEqual({ entries: ['first'], map: {} });
    expect(applyUpsertPatchBatch(original, [ops], () => false).data).toEqual(
      expected
    );
  });

  it('samples message states even when the final document removes the process', () => {
    const original = { processes: {} as Record<string, { running: boolean }> };
    const batch = applyUpsertPatchBatch(
      original,
      [
        [{ op: 'replace', path: '/processes/a', value: { running: true } }],
        [{ op: 'remove', path: '/processes/a' }],
      ],
      (state) => Object.values(state.processes).some((p) => p.running)
    );
    expect(batch.states).toEqual([true, false]);
    expect(batch.data).toEqual(original);
    expect(original.processes).toEqual({});
    expect(() =>
      applyUpsertPatchBatch(
        original,
        [
          [{ op: 'add', path: '/processes/a', value: { running: true } }],
          [{ op: 'add', path: 'invalid-pointer', value: 0 }],
        ],
        (state) => Object.values(state.processes).some((p) => p.running)
      )
    ).toThrow();
    expect(original.processes).toEqual({});
  });

  it('shares untouched branches and throws without mutating the input', () => {
    const original = { entries: ['first'], map: {} };
    const { data: result } = applyUpsertPatchBatch(original, [
      [{ op: 'add', path: '/entries/-', value: 'second' }],
    ]);
    expect(result.map).toBe(original.map);
    expect(applyUpsertPatchBatch(result, []).data).toBe(result);
    expect(() =>
      applyUpsertPatchBatch(original, [
        [
          { op: 'add', path: '/entries/-', value: 'rolled back' },
          { op: 'add', path: 'invalid-pointer', value: 1 },
        ],
      ])
    ).toThrow('Invalid JSON Pointer');
    expect(original.entries).toEqual(['first']);
  });
});
