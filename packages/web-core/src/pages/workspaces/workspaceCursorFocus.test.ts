import { describe, expect, it } from 'vitest';
import { shouldReleaseWorkspaceCursor } from './workspaceCursorFocus';

const settled = {
  focusInSidebar: false,
  modalActive: false,
  documentHasFocus: true,
};

describe('shouldReleaseWorkspaceCursor', () => {
  it('drops the cursor once focus has left the sidebar (Escape, Tab, click away)', () => {
    expect(shouldReleaseWorkspaceCursor(settled)).toBe(true);
  });

  it('keeps the cursor while focus is still inside the sidebar', () => {
    expect(
      shouldReleaseWorkspaceCursor({ ...settled, focusInSidebar: true })
    ).toBe(false);
  });

  it('keeps the cursor while a dialog owns the keyboard', () => {
    expect(
      shouldReleaseWorkspaceCursor({ ...settled, modalActive: true })
    ).toBe(false);
  });

  it('keeps the cursor while the window itself is unfocused', () => {
    expect(
      shouldReleaseWorkspaceCursor({ ...settled, documentHasFocus: false })
    ).toBe(false);
  });
});
