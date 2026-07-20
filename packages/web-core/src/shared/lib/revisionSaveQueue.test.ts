import { describe, expect, it, vi } from 'vitest';
import { RevisionSaveQueue } from './revisionSaveQueue';

describe('RevisionSaveQueue', () => {
  it('serializes saves and chains the returned revisions', async () => {
    let releaseFirst!: (revision: string) => void;
    const firstResult = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const save = vi
      .fn<(value: string, revision: string) => Promise<string>>()
      .mockReturnValueOnce(firstResult)
      .mockResolvedValueOnce('revision-3');
    const queue = new RevisionSaveQueue<string>('revision-1');

    const first = queue.enqueue('first', save);
    const second = queue.enqueue('second', save);
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenNthCalledWith(1, 'first', 'revision-1');

    releaseFirst('revision-2');
    await expect(first).resolves.toMatchObject({ isLatest: false });
    await expect(second).resolves.toEqual({
      value: 'second',
      revision: 'revision-3',
      isLatest: true,
    });
    expect(save).toHaveBeenNthCalledWith(2, 'second', 'revision-2');
  });
});
