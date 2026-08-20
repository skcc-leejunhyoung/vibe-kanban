import { describe, expect, it } from 'vitest';
import {
  isWorkspacePaneDrag,
  workspacePaneDragType,
} from './workspacePaneDrag';

describe('isWorkspacePaneDrag', () => {
  it('ignores unrelated native drags', () => {
    expect(isWorkspacePaneDrag(['Files', 'text/plain'])).toBe(false);
    expect(isWorkspacePaneDrag([workspacePaneDragType])).toBe(true);
  });
});
