/**
 * State-driven keyboard-cursor indicator for list items whose cursor is
 * virtual (isFocused/isCursor/highlightedIndex/data-selected) rather than
 * real DOM focus — real focus targets are covered by the global outline in
 * web-core app/styles/new/index.css instead. Single source so every list
 * renders the same cursor; do not hand-write these classes at call sites.
 */
export const KEYBOARD_CURSOR_RING = 'ring-2 ring-inset ring-brand';
