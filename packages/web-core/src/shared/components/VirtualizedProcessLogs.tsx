import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr';
import RawLogText from '@/shared/components/RawLogText';
import type { PatchType } from 'shared/types';

export type LogEntry = Extract<
  PatchType,
  { type: 'STDOUT' } | { type: 'STDERR' }
>;

export interface VirtualizedProcessLogsProps {
  logs: LogEntry[];
  error: string | null;
  searchQuery: string;
  matchIndices: number[];
  currentMatchIndex: number;
}

interface SearchContext {
  searchQuery: string;
  matchIndices: number[];
  currentMatchIndex: number;
}

function LogItem({
  data,
  index,
  context,
}: {
  data: LogEntry;
  index: number;
  context: SearchContext;
}) {
  const isMatch = context.matchIndices.includes(index);
  const isCurrentMatch =
    context.matchIndices[context.currentMatchIndex] === index;

  return (
    <RawLogText
      content={data.content}
      channel={data.type === 'STDERR' ? 'stderr' : 'stdout'}
      className="text-sm px-4 py-1"
      linkifyUrls
      searchQuery={isMatch ? context.searchQuery : undefined}
      isCurrentMatch={isCurrentMatch}
    />
  );
}

export function VirtualizedProcessLogs({
  logs,
  error,
  searchQuery,
  matchIndices,
  currentMatchIndex,
}: VirtualizedProcessLogsProps) {
  const { t } = useTranslation('tasks');
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const prevCurrentMatchRef = useRef<number | undefined>(undefined);
  // Whether the viewport is pinned to the newest log. Starts true so we follow
  // output immediately; it only flips to false once the user scrolls up to
  // inspect history, at which point we stop yanking them back down.
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Keep the latest log in view while the user hasn't scrolled away from the
  // bottom. This covers both the initial burst (e.g. a dev server replaying its
  // whole history at once) and incremental appends — relying on Virtuoso's
  // followOutput alone can leave the viewport stuck at the top on that first
  // burst.
  useEffect(() => {
    if (!isAtBottom || logs.length === 0) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: logs.length - 1,
        align: 'end',
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [isAtBottom, logs.length]);

  // Scroll to current match when it changes
  useEffect(() => {
    if (
      matchIndices.length > 0 &&
      currentMatchIndex >= 0 &&
      currentMatchIndex !== prevCurrentMatchRef.current
    ) {
      const logIndex = matchIndices[currentMatchIndex];
      virtuosoRef.current?.scrollToIndex({
        index: logIndex,
        align: 'center',
        behavior: 'smooth',
      });
      prevCurrentMatchRef.current = currentMatchIndex;
    }
  }, [currentMatchIndex, matchIndices]);

  if (logs.length === 0 && !error) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-center text-muted-foreground text-sm">
          {t('processes.noLogsAvailable')}
        </p>
      </div>
    );
  }

  if (error && logs.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-center text-destructive text-sm">
          <WarningCircleIcon className="size-icon-base inline mr-2" />
          {error}
        </p>
      </div>
    );
  }

  const context: SearchContext = {
    searchQuery,
    matchIndices,
    currentMatchIndex,
  };

  return (
    <Virtuoso<LogEntry, SearchContext>
      ref={virtuosoRef}
      className="h-full overflow-hidden"
      data={logs}
      context={context}
      computeItemKey={(index) => `log-${index}`}
      itemContent={(index, entry, itemContext) => (
        <LogItem data={entry} index={index} context={itemContext} />
      )}
      initialTopMostItemIndex={Math.max(0, logs.length - 1)}
      atBottomStateChange={setIsAtBottom}
      followOutput={(atBottom) => (atBottom ? 'smooth' : false)}
      increaseViewportBy={{ top: 0, bottom: 600 }}
    />
  );
}
