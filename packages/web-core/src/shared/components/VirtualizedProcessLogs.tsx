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
  const [scroller, setScroller] = useState<HTMLElement | Window | null>(null);
  // Whether we keep the viewport pinned to the newest log. Starts true. It only
  // flips to false when the user *deliberately* scrolls up (wheel / touch drag);
  // a flood of incoming logs must never unpin us. It flips back to true once the
  // user scrolls back down to the bottom.
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  // Detect a deliberate upward scroll from raw input on the scroller element.
  // We watch wheel/touch gestures rather than scroll position, so Virtuoso's own
  // content-driven scrollTop changes (item measurement, fast appends) can never
  // be mistaken for the user scrolling away from the bottom.
  useEffect(() => {
    if (!scroller || scroller instanceof Window) {
      return;
    }
    const unpin = () => setPinnedToBottom(false);
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        unpin();
      }
    };
    let lastTouchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      // Finger moving down scrolls content up — the user is reading history.
      if (y > lastTouchY + 2) {
        unpin();
      }
      lastTouchY = y;
    };
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
    };
  }, [scroller]);

  // Keep the latest log in view while pinned. This covers both the initial burst
  // (e.g. a dev server replaying its whole history at once) and incremental
  // appends — relying on Virtuoso's followOutput alone can leave the viewport
  // stuck at the top on that first burst.
  useEffect(() => {
    if (!pinnedToBottom || logs.length === 0) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: logs.length - 1,
        align: 'end',
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [pinnedToBottom, logs.length]);

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
      scrollerRef={setScroller}
      className="h-full overflow-hidden"
      data={logs}
      context={context}
      computeItemKey={(index) => `log-${index}`}
      itemContent={(index, entry, itemContext) => (
        <LogItem data={entry} index={index} context={itemContext} />
      )}
      initialTopMostItemIndex={Math.max(0, logs.length - 1)}
      // Re-pin when the user scrolls back to the bottom. We deliberately ignore
      // the `false` direction: a fast log burst can momentarily report
      // not-at-bottom, but only a deliberate upward scroll (detected via
      // wheel/touch above) is allowed to unpin.
      atBottomStateChange={(atBottom) => {
        if (atBottom) {
          setPinnedToBottom(true);
        }
      }}
      // Generous threshold so re-pinning kicks in as soon as the user gets near
      // the bottom again, and so small height jitter never affects the readout.
      atBottomThreshold={120}
      // While pinned, always chase the bottom with an instant jump regardless of
      // transient at-bottom state, so a flood of logs can never outrun the
      // scroll. When unpinned, disable following entirely — this also disables
      // Virtuoso's size-increase trap, so incoming logs can't yank the user back
      // down while they read history.
      followOutput={pinnedToBottom ? () => 'auto' : false}
      increaseViewportBy={{ top: 0, bottom: 600 }}
    />
  );
}
