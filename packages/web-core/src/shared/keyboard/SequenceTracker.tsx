import {
  useContext,
  useState,
  useEffect,
  useRef,
  useMemo,
  ReactNode,
} from 'react';
import { createHmrContext } from '@/shared/lib/hmrContext';
import {
  effectiveFirstKeys,
  effectiveValidSequences,
  mapCodeToLogicalKey,
} from '@/shared/keyboard/registry';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';

interface SequenceTrackerContextValue {
  buffer: string[];
  isActive: boolean;
  isInvalid: boolean;
}

const SequenceTrackerContext = createHmrContext<SequenceTrackerContextValue>(
  'SequenceTrackerContext',
  {
    buffer: [],
    isActive: false,
    isInvalid: false,
  }
);

export const useSequenceTracker = () => useContext(SequenceTrackerContext);

const SEQUENCE_TIMEOUT_MS = 1500;
const INVALID_DISPLAY_MS = 400;

interface SequenceTrackerProviderProps {
  children: ReactNode;
}

/**
 * Visual feedback for sequential shortcuts (g>s, v>c).
 * Display-only - execution handled by react-hotkeys-hook.
 *
 * The valid sequences and first keys are derived from the registry with user
 * overrides applied, so rebound shortcuts get correct feedback.
 *
 * IMPORTANT: Uses refs alongside state because React setState is async.
 * Without synchronous ref updates, rapid keypresses read stale state.
 */
export function SequenceTrackerProvider({
  children,
}: SequenceTrackerProviderProps) {
  const [buffer, setBuffer] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(false);
  const [isInvalid, setIsInvalid] = useState(false);

  const overrides = useKeyboardShortcutsStore((s) => s.overrides);
  const firstKeys = useMemo(() => effectiveFirstKeys(overrides), [overrides]);
  const validSequences = useMemo(
    () => effectiveValidSequences(overrides),
    [overrides]
  );

  const bufferRef = useRef<string[]>([]);
  const isActiveRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const invalidTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstKeysRef = useRef(firstKeys);
  const validSequencesRef = useRef(validSequences);

  bufferRef.current = buffer;
  isActiveRef.current = isActive;
  firstKeysRef.current = firstKeys;
  validSequencesRef.current = validSequences;

  useEffect(() => {
    const isValidPartialSequence = (buf: string[]): boolean => {
      if (buf.length === 0) return false;
      if (buf.length === 1) return firstKeysRef.current.has(buf[0]);
      return validSequencesRef.current.has(buf.join(','));
    };

    const clearBuffer = () => {
      bufferRef.current = [];
      isActiveRef.current = false;
      setBuffer([]);
      setIsActive(false);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    const showInvalid = (invalidBuffer: string[]) => {
      bufferRef.current = invalidBuffer;
      isActiveRef.current = false;
      setBuffer(invalidBuffer);
      setIsInvalid(true);
      setIsActive(false);

      if (invalidTimeoutRef.current) {
        clearTimeout(invalidTimeoutRef.current);
      }
      invalidTimeoutRef.current = setTimeout(() => {
        setIsInvalid(false);
        setBuffer([]);
        invalidTimeoutRef.current = null;
      }, INVALID_DISPLAY_MS);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
        return;
      }

      const key = mapCodeToLogicalKey(event.code, event.key);
      if (!key) return;

      const currentIsActive = isActiveRef.current;
      const currentBuffer = bufferRef.current;

      if (!currentIsActive && !firstKeysRef.current.has(key)) {
        return;
      }

      const newBuffer = currentIsActive ? [...currentBuffer, key] : [key];

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      if (newBuffer.length === 1) {
        bufferRef.current = newBuffer;
        isActiveRef.current = true;
        setBuffer(newBuffer);
        setIsActive(true);
        timeoutRef.current = setTimeout(clearBuffer, SEQUENCE_TIMEOUT_MS);
      } else if (newBuffer.length === 2) {
        isActiveRef.current = false;
        if (isValidPartialSequence(newBuffer)) {
          bufferRef.current = newBuffer;
          setBuffer(newBuffer);
          timeoutRef.current = setTimeout(clearBuffer, 200);
        } else {
          showInvalid(newBuffer);
        }
        setIsActive(false);
      } else {
        clearBuffer();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (invalidTimeoutRef.current) clearTimeout(invalidTimeoutRef.current);
    };
  }, []);

  return (
    <SequenceTrackerContext.Provider value={{ buffer, isActive, isInvalid }}>
      {children}
    </SequenceTrackerContext.Provider>
  );
}
