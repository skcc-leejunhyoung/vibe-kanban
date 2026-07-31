import { describe, expect, it, vi } from 'vitest';
import { notifyChangesFileSelection } from './ChangesViewProvider';

describe('notifyChangesFileSelection', () => {
  it('forwards a Changes view request to the mounted panel', () => {
    const callback = vi.fn();

    notifyChangesFileSelection(callback, 'src/requested.ts', 42);

    expect(callback).toHaveBeenCalledWith('src/requested.ts', 42);
  });

  it('allows a request while the Changes panel is not mounted', () => {
    expect(() =>
      notifyChangesFileSelection(null, 'src/requested.ts')
    ).not.toThrow();
  });
});
