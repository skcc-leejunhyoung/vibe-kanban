import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import { useEntries } from '../contexts/EntriesContext';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import { splitStatusSegments, statusTruncate } from '@/shared/lib/statusNote';

export interface LiveStatusDraft {
  text: string;
  /** False only while the block can still grow: its fence has not closed and
   * its message is still the conversation's newest item. */
  closed: boolean;
  executionProcessId: string;
  /** Key of the message the block is in. */
  patchKey: string;
}

export interface StatusHistoryItem {
  text: string;
  /** Entries carry no timestamp; the process that produced it dates it. */
  executionProcessId: string;
}

/**
 * The latest summary block of the session (it streams in while its fence is
 * open; a later message without a block keeps it) plus every settled block the
 * session produced, newest first, each text at most once (newest copy wins).
 * Texts are cut like the server cuts them, so they compare equal to the row.
 */
export interface LiveStatus {
  draft?: LiveStatusDraft;
  history: StatusHistoryItem[];
}

const MOVES_ON = new Set([
  'assistant_message',
  'tool_use',
  'thinking',
  'user_message',
  'user_feedback',
  'user_answered_questions',
  'error_message',
]);

export function computeLiveStatus(entries: PatchTypeWithKey[]): LiveStatus {
  // ponytail: rescans every assistant message per streaming patch; cache per
  // patchKey if long sessions make this show up in profiles.
  // A block can only grow while its message is the conversation's newest
  // item: a tool call, thinking or another message after it means the agent
  // moved on (usage and loading rows do not count).
  const lastItem = entries.findLastIndex(
    (entry) =>
      entry.type === 'NORMALIZED_ENTRY' &&
      MOVES_ON.has(entry.content.entry_type.type)
  );
  const settled: StatusHistoryItem[] = [];
  let draft: LiveStatusDraft | undefined;
  entries.forEach((entry, index) => {
    if (
      entry.type !== 'NORMALIZED_ENTRY' ||
      entry.content.entry_type.type !== 'assistant_message'
    )
      return;
    const blocks = splitStatusSegments(entry.content.content).filter(
      (segment) => segment.kind === 'status' && segment.text
    );
    blocks.forEach((block, blockIndex) => {
      if (block.kind !== 'status') return;
      const text = statusTruncate(block.text);
      const closed =
        block.closed || index < lastItem || blockIndex < blocks.length - 1;
      draft = {
        text,
        closed,
        executionProcessId: entry.executionProcessId,
        patchKey: entry.patchKey,
      };
      if (closed)
        settled.push({ text, executionProcessId: entry.executionProcessId });
    });
  });
  const seen = new Set<string>();
  const history: StatusHistoryItem[] = [];
  for (let index = settled.length - 1; index >= 0; index--) {
    const item = settled[index];
    if (seen.has(item.text)) continue;
    seen.add(item.text);
    history.push(item);
  }
  return { draft, history };
}

function useLiveStatus(): LiveStatus {
  const { entries } = useEntries();
  return useMemo(() => computeLiveStatus(entries), [entries]);
}

const LiveStatusContext = createContext<LiveStatus>({ history: [] });
// Kept apart from the full value, which changes with every streamed token:
// chat rows only need to know which message is still writing its block.
const WritingStatusContext = createContext<string | null | undefined>(
  undefined
);

/** Computes the live summary once for the strip and the chat's markers. */
export function LiveStatusProvider({ children }: { children: ReactNode }) {
  const live = useLiveStatus();
  const writing = live.draft && !live.draft.closed ? live.draft.patchKey : null;
  return createElement(
    LiveStatusContext.Provider,
    { value: live },
    createElement(WritingStatusContext.Provider, { value: writing }, children)
  );
}

export function useLiveStatusValue(): LiveStatus {
  return useContext(LiveStatusContext);
}

/**
 * Key of the message whose summary block can still grow; `undefined` where
 * no conversation tracks it (callers then fall back to the process state).
 */
export function useWritingStatusKey(): string | null | undefined {
  return useContext(WritingStatusContext);
}
