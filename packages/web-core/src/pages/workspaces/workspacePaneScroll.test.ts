import { describe, expect, it } from 'vitest';
import {
  capturePaneScrollPositions,
  restorePaneScrollPositions,
} from './workspacePaneScroll';

describe('workspace pane scroll preservation', () => {
  it('restores every scroll container after a pane reorder', () => {
    const vertical = {
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 500,
      scrollLeft: 0,
      scrollTop: 240,
      scrollWidth: 100,
    };
    const horizontal = {
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 100,
      scrollLeft: 80,
      scrollTop: 0,
      scrollWidth: 500,
    };
    const atTop = {
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 500,
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 100,
    };
    const idle = {
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 100,
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 100,
    };
    const root = {
      querySelectorAll: () => [vertical, horizontal, atTop, idle],
    } as unknown as ParentNode;
    const positions = capturePaneScrollPositions(root);

    vertical.scrollTop = 0;
    horizontal.scrollLeft = 0;
    atTop.scrollTop = 40;
    restorePaneScrollPositions(positions);

    expect(vertical.scrollTop).toBe(240);
    expect(horizontal.scrollLeft).toBe(80);
    expect(atTop.scrollTop).toBe(0);
    expect(positions).toHaveLength(3);
  });
});
