import { applyPatch, type Operation } from 'rfc6902';
import { apply as applyOperation } from 'rfc6902/patch';
import { produce } from 'immer';

/** Apply one immutable batch, optionally sampling state at message boundaries. */
export function applyUpsertPatchBatch<T extends object>(
  target: T,
  messages: Operation[][],
  selectState?: (data: T) => boolean
): { data: T; states: boolean[] } {
  const states: boolean[] = [];
  if (selectState) {
    const data = produce(target, (draft) => {
      for (const ops of messages) {
        // Use the same operation implementation as rfc6902.applyPatch, without
        // allocating an array/API call per op or an immutable doc per message.
        applyUpsertPatch(draft, ops);
        states.push(selectState(draft as T));
      }
    });
    return { data, states };
  }

  const ops = messages.flat();
  try {
    let needsUpsert = false;
    const next = produce(target, (draft) => {
      const errors = applyPatch(draft, ops);
      needsUpsert = errors.some(
        (error, i) => ops[i].op === 'replace' && error?.name === 'MissingError'
      );
    });
    if (!needsUpsert) return { data: next, states };
  } catch {
    // A missing replace can also make a later, dependent op throw.
  }

  // Retry against the untouched input: delaying an upsert until the end
  // breaks dependent ops, and retrying on the partial result duplicates adds.
  return {
    data: produce(target, (draft) => applyUpsertPatch(draft, ops)),
    states,
  };
}

export function applyUpsertPatch(target: object, ops: Operation[]): void {
  ops.forEach((op) => {
    const error = applyOperation(target, op);

    if (op.op === 'replace' && error?.name === 'MissingError') {
      applyOperation(target, { ...op, op: 'add' });
    }
  });
}
