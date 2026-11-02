import { describe, expect, it } from 'vitest';
import { getDialogMaxWidth } from '@vibe/ui/lib/dialog-size';

describe('dialog size', () => {
  it('keeps the two purpose-based widths', () => {
    expect(getDialogMaxWidth('compact')).toBe('32rem');
    expect(getDialogMaxWidth('wide')).toBe('56rem');
  });

  it('removes the max-width constraint for full dialogs', () => {
    expect(getDialogMaxWidth('full')).toBe('none');
  });
});
