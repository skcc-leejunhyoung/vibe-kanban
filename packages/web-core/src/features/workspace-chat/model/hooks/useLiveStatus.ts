import { useMemo } from 'react';
import { useEntries } from '../contexts/EntriesContext';
import { splitStatusSegments, statusTruncate } from '@/shared/lib/statusNote';

export interface LiveStatusDraft {
  text: string;
  /** False only while the block can still grow: it is the last block of the
   * session's last assistant message and its fence has not closed. */
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
 * open; a later message without a block keeps it) plus every settled block the
 * session produced, newest first, each text at most once (newest copy wins).
 * Texts are cut like the server cuts them, so they compare equal to the row.
 */
export function useLiveStatus(): {
  draft?: LiveStatusDraft;
  history: StatusHistoryItem[];
} {
  const { entries } = useEntries();
  return useMemo(() => {
    // ponytail: rescans every assistant message per streaming patch; cache per
    // patchKey if long sessions make this show up in profiles.
    const assistant = entries.filter(
      (entry) =>
        entry.type === 'NORMALIZED_ENTRY' &&
        entry.content.entry_type.type === 'assistant_message'
    );
    const settled: StatusHistoryItem[] = [];
    let draft: LiveStatusDraft | undefined;
    assistant.forEach((entry, index) => {
      if (entry.type !== 'NORMALIZED_ENTRY') return;
      const blocks = splitStatusSegments(entry.content.content).filter(
        (segment) => segment.kind === 'status' && segment.text
      );
      blocks.forEach((block, blockIndex) => {
        if (block.kind !== 'status') return;
        const text = statusTruncate(block.text);
        // An unclosed block followed by anything else can no longer grow.
        const closed =
          block.closed ||
          index < assistant.length - 1 ||
          blockIndex < blocks.length - 1;
        draft = { text, closed, executionProcessId: entry.executionProcessId };
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
  }, [entries]);
}
