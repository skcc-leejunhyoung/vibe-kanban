import { describe, expect, it, vi } from 'vitest';
import {
  getPaneActionExecutor,
  registerPaneActionExecutor,
} from './paneActionRegistry';

describe('paneActionRegistry', () => {
  it('returns the active pane executor and ignores stale cleanup', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const other = vi.fn();
    const unregisterFirst = registerPaneActionExecutor('pane-1', first);
    const unregisterLatest = registerPaneActionExecutor('pane-1', latest);
    const unregisterOther = registerPaneActionExecutor('pane-2', other);

    unregisterFirst();
    expect(getPaneActionExecutor('pane-1')).toBe(latest);

    expect(getPaneActionExecutor('pane-2')).toBe(other);

    unregisterLatest();
    unregisterOther();
  });
});
