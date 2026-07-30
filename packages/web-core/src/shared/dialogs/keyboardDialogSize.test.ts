import { describe, expect, it } from 'vitest';
import { getKeyboardDialogMaxWidth } from '@vibe/ui/lib/keyboard-dialog-size';

describe('KeyboardDialog size', () => {
  it('keeps the default xl width contract', () => {
    expect(getKeyboardDialogMaxWidth('xl')).toBe('36rem');
  });

  it('removes the max-width constraint for full dialogs', () => {
    expect(getKeyboardDialogMaxWidth('full')).toBe('none');
  });
});
