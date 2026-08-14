import { useContext, type ReactNode } from 'react';
import { createHmrContext } from '@/shared/lib/hmrContext';

// Default true → outside the pane grid (full-page render) content behaves as
// the active surface, so single-view keyboard handling is unchanged.
const PaneActiveContext = createHmrContext<boolean>('PaneActiveContext', true);

/**
 * Marks its subtree as belonging to the active pane. Window-level keyboard
 * handlers (each pane registers its own listener) gate on {@link useIsActivePane}
 * so only the focused pane responds to Escape / arrow navigation.
 */
export function PaneActiveProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <PaneActiveContext.Provider value={active}>
      {children}
    </PaneActiveContext.Provider>
  );
}

/** True when this subtree is the active pane (or not in a pane grid at all). */
export function useIsActivePane(): boolean {
  return useContext(PaneActiveContext);
}
