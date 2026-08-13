import { useEffect, useState } from 'react';

/**
 * Returns the value only after it has been stable for `delayMs`. Used to
 * debounce expensive subscriptions keyed by fast-changing state (e.g. the
 * navbar breadcrumb's Electric shape while pane focus hops between
 * workspaces). Undefined until the first value settles.
 */
export function useSettledValue<T>(value: T, delayMs: number): T | undefined {
  const [settled, setSettled] = useState<T | undefined>(undefined);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
