import { useMemo } from 'react';
import { useEntries } from '../contexts/EntriesContext';
import { splitStatusSegments } from '@/shared/lib/statusNote';

export interface LiveStatusDraft {
  text: string;
  /** False while the closing fence has not streamed in. */
  closed: boolean;
  executionProcessId: string;
}

export interface StatusHistoryItem {
  text: string;
  /** Entries carry no timestamp; the process that produced it dates it. */
  executionProcessId: string;
}

/**
 * The latest summary block of the session (it streams in while its fence is
 * open; a later message without a block keeps it) plus every closed block the
 * session produced, newest first.
 */
export function useLiveStatus(): {
  draft?: LiveStatusDraft;
  history: StatusHistoryItem[];
} {
  const { entries } = useEntries();
  return useMemo(() => {
    // ponytail: rescans every assistant message per streaming patch; cache per
    // patchKey if long sessions make this show up in profiles.
    const history: StatusHistoryItem[] = [];
    let draft: LiveStatusDraft | undefined;
    for (const entry of entries) {
      if (
        entry.type !== 'NORMALIZED_ENTRY' ||
        entry.content.entry_type.type !== 'assistant_message'
      )
        continue;
      const blocks = splitStatusSegments(entry.content.content).filter(
        (segment) => segment.kind === 'status' && segment.text
      );
      const last = blocks[blocks.length - 1];
      if (!last || last.kind !== 'status') continue;
      draft = {
        text: last.text,
        closed: last.closed,
        executionProcessId: entry.executionProcessId,
      };
      for (const block of blocks) {
        if (
          block.kind === 'status' &&
          block.closed &&
          history[history.length - 1]?.text !== block.text
        )
          history.push({
            text: block.text,
            executionProcessId: entry.executionProcessId,
          });
      }
    }
    history.reverse();
    return { draft, history };
  }, [entries]);
}
