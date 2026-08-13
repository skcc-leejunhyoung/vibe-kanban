import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createHmrContext } from '@/shared/lib/hmrContext';

// null → not inside a measured pane (full-page render): callers fall back to
// viewport-based behaviour.
const PaneWidthContext = createHmrContext<number | null>(
  'PaneWidthContext',
  null
);

/** Measures its own box and provides the width to descendants. */
export function PaneWidthProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <PaneWidthContext.Provider value={width}>
      <div ref={ref} className="flex h-full min-h-0 min-w-0 flex-col">
        {children}
      </div>
    </PaneWidthContext.Provider>
  );
}

/** Width of the enclosing pane in px, or null outside a measured pane. */
export function usePaneWidth(): number | null {
  return useContext(PaneWidthContext);
}

/**
 * Width-based layout adaptation for pane content. Falls back to the viewport
 * width outside a pane so full-page renders adapt the same way.
 */
export function usePaneNarrowerThan(threshold: number): boolean {
  const paneWidth = usePaneWidth();
  const width =
    paneWidth ?? (typeof window === 'undefined' ? Infinity : window.innerWidth);
  return width < threshold;
}
