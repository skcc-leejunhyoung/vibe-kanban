import { applyPatch, type Operation } from 'rfc6902';
import { produce } from 'immer';

/** Apply a whole batch with structural sharing, preserving ordered upserts. */
export function applyUpsertPatchBatch<T extends object>(
  target: T,
  ops: Operation[]
): T {
  try {
    let needsUpsert = false;
    const next = produce(target, (draft) => {
      const errors = applyPatch(draft, ops);
      needsUpsert = errors.some(
        (error, i) => ops[i].op === 'replace' && error?.name === 'MissingError'
      );
    });
    if (!needsUpsert) return next;
  } catch {
    // A missing replace can also make a later, dependent op throw.
  }

  // Retry against the untouched input: delaying an upsert until the end
  // breaks dependent ops, and retrying on the partial result duplicates adds.
  return produce(target, (draft) => applyUpsertPatch(draft, ops));
}

export function applyUpsertPatch(target: object, ops: Operation[]): void {
  ops.forEach((op) => {
    const [error] = applyPatch(target, [op]);

    if (op.op === 'replace' && error?.name === 'MissingError') {
      applyPatch(target, [{ ...op, op: 'add' }]);
    }
  });
}
