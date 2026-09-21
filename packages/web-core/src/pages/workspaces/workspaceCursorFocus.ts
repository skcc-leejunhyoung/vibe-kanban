/**
 * Whether the sidebar's keyboard cursor should be dropped once DOM focus has
 * settled outside the list. Evaluated a frame after `focusout` rather than on
 * its `relatedTarget`, because a background list update moves the focused
 * row's node — that fires a relatedTarget-less `focusout` which react-dom
 * immediately undoes by restoring focus to the same row.
 */
export function shouldReleaseWorkspaceCursor({
  focusInSidebar,
  modalActive,
  documentHasFocus,
}: {
  focusInSidebar: boolean;
  modalActive: boolean;
  documentHasFocus: boolean;
}): boolean {
  // Row-to-row arrow navigation, a row button, the search box, or the row that
  // was just re-inserted by a render: the cursor follows the focus and stays.
  if (focusInSidebar) return false;
  // A dialog stealing focus is not the user leaving the list — it restores
  // focus to the row on close, so keep the cursor.
  if (modalActive) return false;
  // Switching window/tab keeps the row focused for when we come back.
  if (!documentHasFocus) return false;
  return true;
}
