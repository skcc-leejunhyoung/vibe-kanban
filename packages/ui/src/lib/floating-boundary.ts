import { createContext, useContext, type CSSProperties } from 'react';

/**
 * The element popovers and dropdown menus must stay inside — the workspace
 * pane they were opened from. Null means the viewport (Radix's default).
 * React context crosses the portal, so content rendered into document.body
 * still sees the pane it was opened in.
 */
export const FloatingBoundaryContext = createContext<HTMLElement | null>(null);

export function useFloatingBoundary(): HTMLElement | undefined {
  return useContext(FloatingBoundaryContext) ?? undefined;
}

/**
 * Radix sets `--radix-popper-available-width` on every popper wrapper: the
 * room left inside the collision boundary. Capping the content by it makes a
 * popover wider than a narrow pane shrink to the pane instead of covering the
 * neighbouring one. It's inline so it wins over width classes; a caller that
 * needs a tighter cap passes its own `maxWidth` (combined with this variable).
 */
export function floatingContentStyle(style?: CSSProperties): CSSProperties {
  return { maxWidth: 'var(--radix-popper-available-width)', ...style };
}
