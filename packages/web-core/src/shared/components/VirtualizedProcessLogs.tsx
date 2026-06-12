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

type LogEntryWithKey = LogEntry & { key: string; originalIndex: number };

interface SearchContext {
  searchQuery: string;
  matchIndices: number[];
  currentMatchIndex: number;
}

function LogItem({
  data,
  context,
}: {
  data: LogEntryWithKey;
  context: SearchContext;
}) {
  const isMatch = context.matchIndices.includes(data.originalIndex);
  const isCurrentMatch =
    context.matchIndices[context.currentMatchIndex] === data.originalIndex;

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
  const [logEntries, setLogEntries] = useState<LogEntryWithKey[]>([]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const hasInitializedRef = useRef(false);
  const prevCurrentMatchRef = useRef<number | undefined>(undefined);
  const [isAtBottom, setIsAtBottom] = useState(true);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      const logsWithKeys: LogEntryWithKey[] = logs.map((entry, index) => ({
        ...entry,
        key: `log-${index}`,
        originalIndex: index,
      }));
      setLogEntries(logsWithKeys);
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [logs]);

  useEffect(() => {
    if (!hasInitializedRef.current && logEntries.length > 0) {
      hasInitializedRef.current = true;
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: logEntries.length - 1,
          align: 'end',
        });
      });
    }
  }, [logEntries.length]);

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
    <Virtuoso<LogEntryWithKey, SearchContext>
      ref={virtuosoRef}
      className="h-full overflow-hidden"
      data={logEntries}
      context={context}
      computeItemKey={(_index, entry) => entry.key}
      itemContent={(_index, entry, itemContext) => (
        <LogItem data={entry} context={itemContext} />
      )}
      atBottomStateChange={setIsAtBottom}
      followOutput={isAtBottom ? 'smooth' : false}
      increaseViewportBy={{ top: 0, bottom: 600 }}
    />
  );
}
