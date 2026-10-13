import { useMemo } from 'react';
import { useEntries } from '../contexts/EntriesContext';
import { extractLastStatusBlock } from '@/shared/lib/statusNote';

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
 * The summary block of the latest assistant message (it streams in while the
 * fence is open) plus every closed block this session produced, newest first.
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
      const block = extractLastStatusBlock(entry.content.content);
      draft = block?.text
        ? { ...block, executionProcessId: entry.executionProcessId }
        : undefined;
      if (
        block?.closed &&
        block.text &&
        history[history.length - 1]?.text !== block.text
      )
        history.push({
          text: block.text,
          executionProcessId: entry.executionProcessId,
        });
    }
    history.reverse();
    return { draft, history };
  }, [entries]);
}
