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

// The install marker lives on window (not module scope) so a dev-server HMR
// re-evaluation of this module can't lose track of listeners already attached
// by the previous module instance and double-install.
type TrackerWindow = Window & { __vibeKeyboardModalityUninstall?: () => void };

export function installKeyboardModalityTracker(): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const trackerWindow = window as TrackerWindow;
  const existing = trackerWindow.__vibeKeyboardModalityUninstall;
  if (existing) {
    return existing;
  }

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
  // pointerdown covers mouse, touch, and pen in every supported browser.
  window.addEventListener('pointerdown', handlePointer, true);

  const uninstall = () => {
    delete trackerWindow.__vibeKeyboardModalityUninstall;
    root.classList.remove(KEYBOARD_NAV_CLASS);
    window.removeEventListener('keydown', handleKeyDown, true);
    window.removeEventListener('pointerdown', handlePointer, true);
  };
  trackerWindow.__vibeKeyboardModalityUninstall = uninstall;
  return uninstall;
}
