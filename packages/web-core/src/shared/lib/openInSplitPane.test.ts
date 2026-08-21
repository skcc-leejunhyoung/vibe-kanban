import { describe, expect, it } from 'vitest';
import { paneGridAvailable } from './openInSplitPane';

describe('paneGridAvailable', () => {
  it('supports both desktop apps but not mobile', () => {
    expect(paneGridAvailable('local', false)).toBe(true);
    expect(paneGridAvailable('remote', false)).toBe(true);
    expect(paneGridAvailable('remote', true)).toBe(false);
  });
});
