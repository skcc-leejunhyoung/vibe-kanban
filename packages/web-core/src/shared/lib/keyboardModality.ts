/**
 * Tracks whether the user is currently interacting via keyboard and mirrors
 * it as a `kbd-nav` class on <html>.
 *
 * Why: lists (PR list, workspaces, tables) move focus programmatically with
 * `element.focus()` on ArrowUp/Down. Whether that focus matches
 * `:focus-visible` is a browser heuristic based on the *previous* input —
 * in Chrome the first arrow press after a mouse interaction focuses the row
 * without :focus-visible (no outline) and only the second press shows it.
 * The `kbd-nav` class lets the global focus outline in
 * app/styles/new/index.css switch to plain `:focus` while the keyboard is
 * driving, making the indicator deterministic on the first keypress.
 *
 * The keydown listener runs in the capture phase so the class is already set
 * before any app handler calls `.focus()` on the same keypress.
 */
const KEYBOARD_NAV_CLASS = 'kbd-nav';

let installed = false;

export function installKeyboardModalityTracker(): () => void {
  if (installed || typeof window === 'undefined') {
    return () => {};
  }
  installed = true;

  const root = document.documentElement;

  const handleKeyDown = (event: KeyboardEvent) => {
    // Held modifiers are shortcuts (cmd+C, cmd+click precursors…), not
    // keyboard navigation — same carve-out as the :focus-visible polyfill.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!root.classList.contains(KEYBOARD_NAV_CLASS)) {
      root.classList.add(KEYBOARD_NAV_CLASS);
    }
  };

  const handlePointer = () => {
    if (root.classList.contains(KEYBOARD_NAV_CLASS)) {
      root.classList.remove(KEYBOARD_NAV_CLASS);
    }
  };

  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('pointerdown', handlePointer, true);
  window.addEventListener('mousedown', handlePointer, true);
  window.addEventListener('touchstart', handlePointer, true);

  return () => {
    installed = false;
    root.classList.remove(KEYBOARD_NAV_CLASS);
    window.removeEventListener('keydown', handleKeyDown, true);
    window.removeEventListener('pointerdown', handlePointer, true);
    window.removeEventListener('mousedown', handlePointer, true);
    window.removeEventListener('touchstart', handlePointer, true);
  };
}
