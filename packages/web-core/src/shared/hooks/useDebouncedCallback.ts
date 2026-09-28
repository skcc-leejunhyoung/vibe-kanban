import { useRef, useEffect } from 'react';

/**
 * Returns a debounced version of the callback that delays invocation
 * until after `delay` milliseconds have elapsed since the last call.
 * Also returns a cancel function to clear any pending invocation, and a flush
 * function to run it immediately instead.
 */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delay: number
): {
  debounced: (...args: Args) => void;
  cancel: () => void;
  flush: () => void;
} {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArgsRef = useRef<Args | null>(null);
  const callbackRef = useRef(callback);

  // Keep callback ref up to date
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Return stable function reference
  const debouncedRef = useRef((...args: Args) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    pendingArgsRef.current = args;
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      pendingArgsRef.current = null;
      callbackRef.current(...args);
    }, delay);
  });

  // Cancel function to clear pending timeout
  const cancelRef = useRef(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    pendingArgsRef.current = null;
  });

  // Run the pending invocation now, if any
  const flushRef = useRef(() => {
    const args = pendingArgsRef.current;
    cancelRef.current();
    if (args) callbackRef.current(...args);
  });

  return {
    debounced: debouncedRef.current,
    cancel: cancelRef.current,
    flush: flushRef.current,
  };
}
