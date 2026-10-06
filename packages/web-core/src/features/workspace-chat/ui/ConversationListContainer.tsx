import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { SpinnerIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import {
  buildConversationRowsIncremental,
  findPreviousUserMessageIndex,
  type ConversationRow,
} from '../model/conversation-row-model';
import { deriveConversationEntries } from '../model/deriveConversationEntries';
import { deriveConversationTimeline } from '../model/deriveConversationTimeline';
import { useConversationVirtualizer } from '../model/useConversationVirtualizer';
import { useScrollCommandExecutor } from '../model/useScrollCommandExecutor';
import {
  isTopGrowthUpdate,
  topGrowthScrollDelta,
} from '../model/conversation-scroll-anchor';
import { isNearBottom } from '../model/conversation-scroll-commands';

import DisplayConversationEntry from './DisplayConversationEntry';
import { ExecutionArtifactResults } from './ArtifactCards';
import { ApprovalFormProvider } from '@/shared/hooks/ApprovalForm';
import { useEntriesActions } from '../model/contexts/EntriesContext';
import {
  useResetProcess,
  type UseResetProcessResult,
} from '../model/hooks/useResetProcess';
import type {
  AddEntryType,
  ConversationTimelineSource,
  DisplayEntry,
  ExecutionProcessState,
  PatchTypeWithKey,
} from '@/shared/hooks/useConversationHistory/types';
import {
  isAggregatedGroup,
  isAggregatedDiffGroup,
  isAggregatedThinkingGroup,
} from '@/shared/hooks/useConversationHistory/types';
import { useConversationHistory } from '../model/hooks/useConversationHistory';
import { useSetTokenUsageInfo } from '../model/contexts/EntriesContext';
import type { WorkspaceWithSession } from '@/shared/types/attempt';
import type { RepoWithTargetBranch } from 'shared/types';
import { ChatEmptyState } from '@vibe/ui/components/ChatEmptyState';
import { ChatScriptPlaceholder } from '@vibe/ui/components/ChatScriptPlaceholder';
import { ScriptFixerDialog } from '@/shared/dialogs/scripts/ScriptFixerDialog';

interface ConversationListProps {
  attempt: WorkspaceWithSession;
  repos?: RepoWithTargetBranch[];
  onAtBottomChange?: (atBottom: boolean) => void;
  sessionScopeId?: string;
}

export interface ConversationListHandle {
  scrollToPreviousUserMessage: () => void;
  scrollToBottom: (behavior?: 'auto' | 'smooth') => void;
  adjustScrollBy: (delta: number) => void;
  getScrollElement: () => HTMLDivElement | null;
  scrollToEntryByPatchKey: (patchKey: string) => void;
  /**
   * Jump to a turn by its execution-process id, paging in older history first
   * if that turn hasn't been loaded yet. Used by the turn navigator so it can
   * list every turn, not only the ones already fetched.
   */
  scrollToProcess: (processId: string) => void;
  getVisibleUserMessagePatchKey: () => string | null;
}

const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
const STREAMING_UNVIRTUALIZED_BUFFER_ROWS = 24;
// A navigation is done once its row has held the top of the viewport for this
// many frames; the timeout bounds pathological layouts, not normal settling.
const NAVIGATION_SETTLE_FRAMES = 3;
const NAVIGATION_TIMEOUT_MS = 4000;

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// Semantic key of the first row whose bottom edge is inside the viewport.
// Rows render in index order (virtual window, then the unvirtualized tail), so
// document order works. Read from the DOM rather than mapped through an
// index: a batch that has reached the rows but not yet the DOM shifts indices.
function findFirstVisibleRowKey(scrollEl: HTMLElement): string | null {
  const containerTop = scrollEl.getBoundingClientRect().top;
  for (const node of scrollEl.querySelectorAll<HTMLElement>(
    '[data-semantic-key]'
  )) {
    if (node.getBoundingClientRect().bottom <= containerTop + 1) continue;
    return node.dataset.semanticKey ?? null;
  }
  return null;
}

const isUserEntry = (entry: PatchTypeWithKey) =>
  entry.type === 'NORMALIZED_ENTRY' &&
  entry.content.entry_type.type === 'user_message';

// Only these raw entries influence other processes / the final next-action
// state. Keep them in the source when substituting a cached process's output.
function isSemanticEntry(entry: PatchTypeWithKey) {
  if (entry.type !== 'NORMALIZED_ENTRY') return false;
  const type = entry.content.entry_type;
  return (
    type.type === 'token_usage_info' ||
    (type.type === 'tool_use' && type.status.status === 'pending_approval') ||
    (type.type === 'error_message' && type.error_type.type === 'setup_required')
  );
}

const aggregationBoundary: PatchTypeWithKey = {
  type: 'NORMALIZED_ENTRY',
  content: {
    entry_type: { type: 'user_message' },
    content: '',
    timestamp: null,
  },
  patchKey: 'aggregation-boundary',
  executionProcessId: '',
};

/** Per-conversation cache; discard it when the host/session scope changes. */
export function createConversationDerivation() {
  type ProcessCache = {
    raw: PatchTypeWithKey[];
    action: ExecutionProcessState['executionProcess']['executor_action'];
    status: string | undefined;
    exitCode: bigint | null | undefined;
    semanticEntries: PatchTypeWithKey[];
    entries: PatchTypeWithKey[];
    userCount: number;
  };
  const processes = new Map<string, ProcessCache>();
  const scriptOutputCache = new Map<
    string,
    { count: number; output: string }
  >();
  let context: ExecutionProcessState['executionProcess'][] = [];
  let blocks = new Map<
    string,
    {
      parts: ProcessCache[];
      input: PatchTypeWithKey[];
      multipleUsers: boolean;
      laterUser: boolean;
      displayEntries: DisplayEntry[];
      rows: ConversationRow[];
    }
  >();

  return (source: ConversationTimelineSource) => {
    const ordered = Object.values(source.executionProcessState).sort(
      (a, b) =>
        Date.parse(a.executionProcess.created_at) -
        Date.parse(b.executionProcess.created_at)
    );
    // Ordering/actions affect setup prompts, first/last turns, and handoffs.
    // Ordinary status and log updates invalidate only their own process.
    if (
      ordered.length !== context.length ||
      ordered.some(
        (p, i) =>
          p.executionProcess.id !== context[i].id ||
          p.executionProcess.executor_action !== context[i].executor_action
      )
    ) {
      processes.clear();
    }
    context = ordered.map((p) => p.executionProcess);
    const live = new Map(source.liveExecutionProcesses.map((p) => [p.id, p]));
    const currentScriptOutputCache = new Map(scriptOutputCache);
    const sparseState: ConversationTimelineSource['executionProcessState'] = {};
    const changed = new Set<string>();
    for (const process of ordered) {
      const id = process.executionProcess.id;
      const cached = processes.get(id);
      const current = live.get(id);
      if (
        cached?.raw === process.entries &&
        cached.action === process.executionProcess.executor_action &&
        cached.status === current?.status &&
        cached.exitCode === current?.exit_code
      ) {
        sparseState[id] = { ...process, entries: cached.semanticEntries };
        const output = scriptOutputCache.get(id);
        if (output)
          currentScriptOutputCache.set(id, {
            ...output,
            count: cached.semanticEntries.length,
          });
      } else {
        sparseState[id] = process;
        changed.add(id);
      }
    }
    const derived = deriveConversationEntries({
      source: { ...source, executionProcessState: sparseState },
      scriptOutputCache: currentScriptOutputCache,
    });
    const entriesByProcess = new Map<string, PatchTypeWithKey[]>();
    for (const entry of derived.entries) {
      let group = entriesByProcess.get(entry.executionProcessId);
      if (!group) {
        group = [];
        entriesByProcess.set(entry.executionProcessId, group);
      }
      group.push(entry);
    }
    for (const process of ordered) {
      const id = process.executionProcess.id;
      if (!changed.has(id)) continue;
      const output = currentScriptOutputCache.get(id);
      if (output) scriptOutputCache.set(id, output);
      const entries = entriesByProcess.get(id) ?? [];
      const previousEntries = processes.get(id)?.entries;
      // These few generated entries are not backed by stream references.
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!/:(user|script|handoff|loading)$/.test(entry.patchKey)) continue;
        const previous = previousEntries?.find(
          (old) => old.patchKey === entry.patchKey
        );
        if (previous && JSON.stringify(previous) === JSON.stringify(entry))
          entries[i] = previous;
      }
      processes.set(id, {
        raw: process.entries,
        action: process.executionProcess.executor_action,
        status: live.get(id)?.status,
        exitCode: live.get(id)?.exit_code,
        semanticEntries: process.entries.filter(isSemanticEntry),
        entries,
        userCount: entries.filter(isUserEntry).length,
      });
    }
    for (const id of scriptOutputCache.keys()) {
      if (!(id in sparseState)) scriptOutputCache.delete(id);
    }

    const entries: PatchTypeWithKey[] = [];
    const groups: ProcessCache[][] = [];
    let userCount = 0;
    for (const process of ordered) {
      const cached = processes.get(process.executionProcess.id)!;
      entries.push(...cached.entries);
      userCount += cached.userCount;
      if (!cached.entries.length) continue;
      const first = cached.entries[0];
      // Synthetic user/script/handoff entries break every aggregation kind.
      // Promptless processes share a block so tools/thinking can span them.
      if (!groups.length || /:(user|script|handoff)$/.test(first.patchKey)) {
        groups.push([]);
      }
      groups.at(-1)!.push(cached);
    }
    entries.push(...(entriesByProcess.get('') ?? []));

    const nextBlocks: typeof blocks = new Map();
    const displayEntries: DisplayEntry[] = [];
    const rows: ConversationRow[] = [];
    let remainingUsers = userCount;
    for (const parts of groups) {
      const key = parts[0].entries[0].executionProcessId;
      remainingUsers -= parts.reduce((sum, part) => sum + part.userCount, 0);
      const multipleUsers = userCount > 1;
      const laterUser = remainingUsers > 0;
      let block = blocks.get(key);
      if (
        !block ||
        block.multipleUsers !== multipleUsers ||
        block.laterUser !== laterUser ||
        block.parts.length !== parts.length ||
        parts.some((part, i) => part !== block!.parts[i])
      ) {
        const input =
          parts.length === 1
            ? parts[0].entries
            : parts.flatMap((part) => part.entries);
        let prefixLength = 0;
        let start = 0;
        if (
          block &&
          block.multipleUsers === multipleUsers &&
          block.laterUser === laterUser
        ) {
          let common = 0;
          while (common < input.length && input[common] === block.input[common])
            common++;
          if (common === input.length && common === block.input.length) {
            block = { ...block, parts, input };
            nextBlocks.set(key, block);
            displayEntries.push(...block.displayEntries);
            rows.push(...block.rows);
            continue;
          }
          // Resume at the last unchanged, visible aggregation barrier. This
          // also keeps a single long streaming process incremental. Include
          // the barrier itself so no tool/thinking group can cross the cut.
          for (let i = common - 1; i >= 0; i--) {
            const entry = input[i];
            if (
              entry.type === 'NORMALIZED_ENTRY' &&
              entry.content.entry_type.type !== 'thinking' &&
              entry.content.entry_type.type !== 'tool_use'
            ) {
              const index = block.displayEntries.findIndex(
                (old) => old.patchKey === entry.patchKey
              );
              if (index >= 0) {
                start = i;
                prefixLength = index;
                break;
              }
            }
          }
        }
        const tail = input.slice(start);
        // Preserve the global "previous thinking turn" rule locally, then
        // remove the boundary markers before exposing rows to the renderer.
        if (multipleUsers) tail.unshift(aggregationBoundary);
        if (multipleUsers && laterUser) tail.push(aggregationBoundary);
        const timeline = deriveConversationTimeline(tail, [], []);
        const previousDisplayEntries =
          block?.displayEntries.slice(prefixLength) ?? [];
        const previousRows = block?.rows.slice(prefixLength) ?? [];
        const previous = new Map(
          previousDisplayEntries.map((entry) => [entry.patchKey, entry])
        );
        const stable = timeline.displayEntries
          .filter((entry) => entry !== aggregationBoundary)
          .map((entry) => {
            const old = previous.get(entry.patchKey);
            if (!old || old.type !== entry.type) return entry;
            if (
              'entries' in old &&
              'entries' in entry &&
              old.entries.length === entry.entries.length &&
              old.entries.every((item, i) => item === entry.entries[i])
            )
              return old;
            return entry;
          });
        block = {
          parts,
          input,
          multipleUsers,
          laterUser,
          displayEntries: [
            ...(block?.displayEntries.slice(0, prefixLength) ?? []),
            ...stable,
          ],
          rows: [
            ...(block?.rows.slice(0, prefixLength) ?? []),
            ...buildConversationRowsIncremental(
              stable,
              previousDisplayEntries,
              previousRows
            ),
          ],
        };
      }
      nextBlocks.set(key, block);
      displayEntries.push(...block.displayEntries);
      rows.push(...block.rows);
    }
    blocks = nextBlocks;
    return { ...derived, entries, displayEntries, rows };
  };
}

function renderRowContent(
  entry: DisplayEntry,
  attempt: WorkspaceWithSession,
  resetAction: UseResetProcessResult,
  repos: RepoWithTargetBranch[]
): React.ReactNode {
  if (isAggregatedGroup(entry)) {
    return (
      <DisplayConversationEntry
        expansionKey={entry.patchKey}
        aggregatedGroup={entry}
        aggregatedDiffGroup={null}
        aggregatedThinkingGroup={null}
        entry={null}
        executionProcessId={entry.executionProcessId}
        workspaceWithSession={attempt}
        resetAction={resetAction}
        repos={repos}
      />
    );
  }

  if (isAggregatedDiffGroup(entry)) {
    return (
      <DisplayConversationEntry
        expansionKey={entry.patchKey}
        aggregatedGroup={null}
        aggregatedDiffGroup={entry}
        aggregatedThinkingGroup={null}
        entry={null}
        executionProcessId={entry.executionProcessId}
        workspaceWithSession={attempt}
        resetAction={resetAction}
        repos={repos}
      />
    );
  }

  if (isAggregatedThinkingGroup(entry)) {
    return (
      <DisplayConversationEntry
        expansionKey={entry.patchKey}
        aggregatedGroup={null}
        aggregatedDiffGroup={null}
        aggregatedThinkingGroup={entry}
        entry={null}
        executionProcessId={entry.executionProcessId}
        workspaceWithSession={attempt}
        resetAction={resetAction}
        repos={repos}
      />
    );
  }

  if (entry.type === 'STDOUT') {
    return <p>{entry.content}</p>;
  }
  if (entry.type === 'STDERR') {
    return <p>{entry.content}</p>;
  }

  if (entry.type === 'NORMALIZED_ENTRY') {
    return (
      <DisplayConversationEntry
        expansionKey={entry.patchKey}
        entry={entry.content}
        aggregatedGroup={null}
        aggregatedDiffGroup={null}
        aggregatedThinkingGroup={null}
        executionProcessId={entry.executionProcessId}
        workspaceWithSession={attempt}
        resetAction={resetAction}
        repos={repos}
      />
    );
  }

  return null;
}

export const ConversationList = forwardRef<
  ConversationListHandle,
  ConversationListProps
>(function ConversationList(
  { attempt, repos: reposProp = [], onAtBottomChange, sessionScopeId },
  ref
) {
  const { t } = useTranslation('common');
  const repos = reposProp;
  const resetAction = useResetProcess(attempt.id, attempt.session?.id);
  const conversationScopeKey = `${attempt.id}:${sessionScopeId ?? attempt.session?.id ?? 'new'}`;
  const [filteredEntries, setFilteredEntries] = useState<DisplayEntry[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasSetupScriptRun, setHasSetupScriptRun] = useState(false);
  const [hasCleanupScriptRun, setHasCleanupScriptRun] = useState(false);
  const [hasRunningProcess, setHasRunningProcess] = useState(false);
  const lastSettledTailStartIndexRef = useRef<number | null>(null);
  const { setEntries, reset } = useEntriesActions();
  const setTokenUsageInfo = useSetTokenUsageInfo();
  const deriveConversationRef = useRef(createConversationDerivation());
  const scrollOnEntriesChangedRef = useRef<
    ((addType: AddEntryType, isInitialLoad: boolean) => void) | null
  >(null);
  const pendingUpdateRef = useRef<{
    source: ConversationTimelineSource;
    addType: AddEntryType;
    loading: boolean;
    isInitialLoad: boolean;
  } | null>(null);
  // rAF throttle: at most one state update per animation frame.
  // Replaces the previous 100ms trailing debounce which never fired during
  // continuous streaming (upstream rAF in streamJsonPatchEntries reset the
  // timer every ~16ms). TanStack Virtual has no internal batching — unlike
  // Virtuoso — so we need to drive renders explicitly via React state.
  // rAF naturally limits updates to the display refresh rate (~60fps) while
  // ensuring every frame reflects the latest data.
  const rafIdRef = useRef<number | null>(null);
  const planRevealSpacerRef = useRef<HTMLDivElement | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const pendingInteractionAnchorDeadlineRef = useRef(0);
  // Scroll-anchor compensation for background history loading. Older turns
  // stream in AFTER the initial view and prepend above whatever is on screen.
  // While the reader is scrolled up, each prepend grows the content above the
  // viewport and would push their position down. We hold the viewport by adding
  // the height growth back onto scrollTop. Driven by a ResizeObserver on the
  // content (not just the data commit) because TanStack Virtual's total size
  // can settle a frame AFTER the React commit, so a commit-only correction
  // reads a zero delta and never fires — exactly the drift users still saw.
  const topGrowthHoldDeadlineRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  // A navigation owns the viewport from the click until its row has settled.
  // The token cancels a superseded loop; the flag keeps the bottom follow from
  // re-pinning while batches land and lets the history hold run from the
  // bottom too, so the view stays put until the jump.
  const navigationTokenRef = useRef(0);
  const navigationActiveRef = useRef(false);

  // Use ref to access current repos without causing callback recreation
  const reposRef = useRef(repos);
  reposRef.current = repos;

  // Check if any repo has setup or cleanup scripts configured
  const hasSetupScript = repos.some((repo) => repo.setup_script);
  const hasCleanupScript = repos.some((repo) => repo.cleanup_script);

  // Handlers to open script fixer dialog for setup/cleanup scripts
  const handleConfigureSetup = useCallback(() => {
    const currentRepos = reposRef.current;
    if (currentRepos.length === 0) return;

    ScriptFixerDialog.show({
      scriptType: 'setup',
      repos: currentRepos,
      workspaceId: attempt.id,
      sessionId: attempt.session?.id,
    });
  }, [attempt.id, attempt.session?.id]);

  const handleConfigureCleanup = useCallback(() => {
    const currentRepos = reposRef.current;
    if (currentRepos.length === 0) return;

    ScriptFixerDialog.show({
      scriptType: 'cleanup',
      repos: currentRepos,
      workspaceId: attempt.id,
      sessionId: attempt.session?.id,
    });
  }, [attempt.id, attempt.session?.id]);

  // Determine if configure buttons should be shown
  const canConfigure = repos.length > 0;

  useEffect(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    pendingUpdateRef.current = null;
    topGrowthHoldDeadlineRef.current = 0;
    lastScrollHeightRef.current = 0;
    navigationTokenRef.current += 1;
    navigationActiveRef.current = false;
    deriveConversationRef.current = createConversationDerivation();
    if (planRevealSpacerRef.current) {
      planRevealSpacerRef.current.style.height = '0px';
    }
    setLoading(true);
    setHasSetupScriptRun(false);
    setHasCleanupScriptRun(false);
    setHasRunningProcess(false);
    setFilteredEntries([]);
    setDataVersion(0);
    lastSettledTailStartIndexRef.current = null;
    reset();
  }, [conversationScopeKey, reset]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // ---- TanStack Virtual plumbing ----
  const tanstackScrollRef = useRef<HTMLDivElement | null>(null);
  const conversationContentRef = useRef<HTMLDivElement | null>(null);
  const virtualBlockRef = useRef<HTMLDivElement | null>(null);

  const clearPendingInteractionAnchor = useCallback(() => {
    if (pendingInteractionAnchorFrameRef.current !== null) {
      cancelAnimationFrame(pendingInteractionAnchorFrameRef.current);
      pendingInteractionAnchorFrameRef.current = null;
    }
    pendingInteractionAnchorDeadlineRef.current = 0;
    pendingInteractionAnchorRef.current = null;
  }, []);

  const programmaticScrollDeadlineRef = useRef(0);

  const shouldSuppressInteractionDrivenSizeAdjustment = useCallback(
    () =>
      performance.now() < programmaticScrollDeadlineRef.current ||
      (pendingInteractionAnchorRef.current !== null &&
        performance.now() < pendingInteractionAnchorDeadlineRef.current),
    []
  );

  const runInteractionAnchorCorrection = useCallback(() => {
    pendingInteractionAnchorFrameRef.current = null;

    const anchor = pendingInteractionAnchorRef.current;
    const activeScrollContainer = tanstackScrollRef.current;
    if (!anchor || !activeScrollContainer || !anchor.element.isConnected) {
      clearPendingInteractionAnchor();
      return;
    }

    const currentTop = anchor.element.getBoundingClientRect().top;
    const delta = currentTop - anchor.top;
    if (Math.abs(delta) >= 0.5) {
      activeScrollContainer.scrollTop += delta;
    }

    if (performance.now() < pendingInteractionAnchorDeadlineRef.current) {
      pendingInteractionAnchorFrameRef.current = requestAnimationFrame(
        runInteractionAnchorCorrection
      );
      return;
    }

    clearPendingInteractionAnchor();
  }, [clearPendingInteractionAnchor]);

  const handleConversationClickCapture = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const trigger = target.closest<HTMLElement>(
        'button, summary, [role="button"], [data-scroll-anchor-target]'
      );
      if (!trigger || trigger.closest('[data-scroll-anchor-ignore]')) return;

      const scrollContainer = tanstackScrollRef.current;
      if (!scrollContainer || !scrollContainer.contains(trigger)) return;

      clearPendingInteractionAnchor();
      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      pendingInteractionAnchorDeadlineRef.current = performance.now() + 250;
      pendingInteractionAnchorFrameRef.current = requestAnimationFrame(
        runInteractionAnchorCorrection
      );
    },
    [clearPendingInteractionAnchor, runInteractionAnchorCorrection]
  );

  const flushPendingUpdate = () => {
    rafIdRef.current = null;
    const pending = pendingUpdateRef.current;
    if (!pending) return;

    // Arm the top-growth hold while older turns (historic batches) stream in
    // and the reader is scrolled up. Reads the pre-commit DOM (this is a rAF
    // callback, before the setState below), so scroll position reflects where
    // the reader actually is. The compensation itself runs off the content
    // ResizeObserver / layout effect below. Refreshed on every batch so the
    // hold lasts as long as history keeps arriving.
    if (isTopGrowthUpdate(pending.addType)) {
      const scrollEl = tanstackScrollRef.current;
      if (
        scrollEl &&
        (navigationActiveRef.current ||
          !isNearBottom(
            scrollEl.scrollTop,
            scrollEl.clientHeight,
            scrollEl.scrollHeight
          ))
      ) {
        topGrowthHoldDeadlineRef.current = performance.now() + 600;
      }
    }

    const derivedEntries = deriveConversationRef.current(pending.source);

    setHasSetupScriptRun(derivedEntries.hasSetupScriptRun);
    setHasCleanupScriptRun(derivedEntries.hasCleanupScriptRun);
    setHasRunningProcess(derivedEntries.hasRunningProcess);
    setTokenUsageInfo(derivedEntries.latestTokenUsageInfo);

    prevRowsRef.current = derivedEntries.rows;

    setFilteredEntries(derivedEntries.displayEntries);
    setDataVersion((current) => current + 1);
    setEntries(derivedEntries.entries);

    scrollOnEntriesChangedRef.current?.(pending.addType, pending.isInitialLoad);

    if (loading) {
      setLoading(pending.loading);
    }
  };

  const onTimelineUpdated = (
    source: ConversationTimelineSource,
    addType: AddEntryType,
    newLoading: boolean
  ) => {
    pendingUpdateRef.current = {
      source,
      addType,
      loading: newLoading,
      isInitialLoad: addType === 'initial',
    };

    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(flushPendingUpdate);
    }
  };

  const {
    isFirstTurn,
    isLoadingHistory,
    hasMoreHistory,
    loadOlderHistory,
    loadOlderBatch,
    loadUntilProcess,
  } = useConversationHistory({
    attempt,
    onTimelineUpdated,
    scopeKey: conversationScopeKey,
  });

  const prevRowsRef = useRef<ConversationRow[]>([]);
  const conversationRows = useMemo(
    () => prevRowsRef.current,
    [filteredEntries]
  );

  const hasActiveStreamingTurn = useMemo(
    () =>
      hasRunningProcess ||
      conversationRows.some((row) => row.rowFamily === 'loading'),
    [conversationRows, hasRunningProcess]
  );

  const artifactResultRows = useMemo(
    () =>
      new Set(
        new Map(
          conversationRows.map((row) => [
            row.entry.executionProcessId,
            row.entry.patchKey,
          ])
        ).values()
      ),
    [conversationRows]
  );

  const candidateFirstUnvirtualizedRowIndex = useMemo(() => {
    const firstTailRowIndex = Math.max(
      conversationRows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS,
      0
    );

    if (!hasActiveStreamingTurn) {
      return firstTailRowIndex;
    }

    for (let index = conversationRows.length - 1; index >= 0; index -= 1) {
      if (conversationRows[index]?.isUserMessage) {
        return Math.min(index, firstTailRowIndex);
      }
    }

    return firstTailRowIndex;
  }, [conversationRows, hasActiveStreamingTurn]);

  const streamingFirstUnvirtualizedRowIndex = useMemo(() => {
    const lastSettledTailStartIndex = lastSettledTailStartIndexRef.current;
    if (lastSettledTailStartIndex == null) {
      return candidateFirstUnvirtualizedRowIndex;
    }

    return Math.min(
      lastSettledTailStartIndex,
      candidateFirstUnvirtualizedRowIndex
    );
  }, [candidateFirstUnvirtualizedRowIndex]);

  useEffect(() => {
    if (!hasActiveStreamingTurn) {
      lastSettledTailStartIndexRef.current =
        candidateFirstUnvirtualizedRowIndex;
    }
  }, [candidateFirstUnvirtualizedRowIndex, hasActiveStreamingTurn]);

  const firstUnvirtualizedRowIndex = hasActiveStreamingTurn
    ? Math.max(
        0,
        streamingFirstUnvirtualizedRowIndex -
          STREAMING_UNVIRTUALIZED_BUFFER_ROWS
      )
    : candidateFirstUnvirtualizedRowIndex;

  const virtualizedRows = useMemo(
    () => conversationRows.slice(0, firstUnvirtualizedRowIndex),
    [conversationRows, firstUnvirtualizedRowIndex]
  );

  const unvirtualizedTailRows = useMemo(
    () => conversationRows.slice(firstUnvirtualizedRowIndex),
    [conversationRows, firstUnvirtualizedRowIndex]
  );

  const conversationVirtualizer = useConversationVirtualizer({
    rows: virtualizedRows,
    totalRowCount: conversationRows.length,
    scrollContainerRef: tanstackScrollRef,
    contentRef: conversationContentRef,
    onAtBottomChange,
    shouldSuppressSizeAdjustment: shouldSuppressInteractionDrivenSizeAdjustment,
  });

  // NOTE: Do NOT call conversationVirtualizer.virtualizer.measure() when
  // firstUnvirtualizedRowIndex changes. measure() wipes ALL cached item sizes,
  // triggering a massive re-measurement storm and multi-second jitter.
  // TanStack Virtual handles count changes automatically via getItemKey.

  const scrollToAbsoluteIndex = useCallback(
    (
      index: number,
      align: 'start' | 'center' | 'end' = 'start',
      behavior: 'auto' | 'smooth' = 'smooth'
    ): boolean => {
      if (index < 0 || index >= conversationRows.length) return false;

      const scrollEl = tanstackScrollRef.current;
      if (!scrollEl) return false;

      const targetNode = scrollEl.querySelector<HTMLElement>(
        `[data-row-index="${index}"]`
      );

      if (targetNode) {
        // Content-space top via rects: virtualized rows are positioned with
        // translateY, which offsetTop does not see.
        const nodeTop =
          scrollEl.scrollTop +
          targetNode.getBoundingClientRect().top -
          scrollEl.getBoundingClientRect().top;
        let top = nodeTop;

        if (align === 'center') {
          top =
            nodeTop - scrollEl.clientHeight / 2 + targetNode.offsetHeight / 2;
        } else if (align === 'end') {
          top = nodeTop - scrollEl.clientHeight + targetNode.offsetHeight;
        }

        const requestedTop = Math.max(0, top);
        let maxScrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
        const deficit = requestedTop - maxScrollable;

        if (deficit > 1 && align === 'start' && planRevealSpacerRef.current) {
          conversationVirtualizer.releaseBottomLock();
          planRevealSpacerRef.current.style.height = `${Math.ceil(deficit)}px`;
          maxScrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
        }

        scrollEl.scrollTo({
          top: Math.min(requestedTop, maxScrollable),
          behavior,
        });
        return true;
      }

      if (index < virtualizedRows.length) {
        conversationVirtualizer.scrollToIndex(index, { align, behavior });
        return true;
      }

      return false;
    },
    [conversationRows.length, conversationVirtualizer, virtualizedRows.length]
  );

  const scrollToBottomAndClearSpacer = useCallback(
    (behavior?: 'auto' | 'smooth') => {
      navigationTokenRef.current += 1;
      navigationActiveRef.current = false;
      if (planRevealSpacerRef.current) {
        planRevealSpacerRef.current.style.height = '0px';
      }
      conversationVirtualizer.scrollToBottom(behavior);
    },
    [conversationVirtualizer]
  );

  // Batches paged in for a navigation must resolve to preserve-anchor, never
  // follow-bottom: that would re-engage the bottom lock and undo the jump.
  const checkIsAtBottomForIntent = useCallback(
    () =>
      !navigationActiveRef.current && conversationVirtualizer.checkIsAtBottom(),
    [conversationVirtualizer]
  );

  const scrollExecutor = useScrollCommandExecutor({
    virtualizer: conversationVirtualizer.virtualizer,
    itemCount: conversationRows.length,
    dataVersion,
    checkIsAtBottom: checkIsAtBottomForIntent,
    scrollToBottom: scrollToBottomAndClearSpacer,
    scrollToAbsoluteIndex,
  });
  scrollOnEntriesChangedRef.current = scrollExecutor.onEntriesChanged;

  const beginNavigation = useCallback(() => {
    conversationVirtualizer.releaseBottomLock();
    navigationActiveRef.current = true;
    return ++navigationTokenRef.current;
  }, [conversationVirtualizer]);

  // Hands the viewport back: TanStack's own above-viewport size adjustments
  // resume, and the history hold is disarmed so it cannot add the same growth
  // a second time on top of them.
  const endNavigation = useCallback((token: number) => {
    if (navigationTokenRef.current !== token) return;
    navigationActiveRef.current = false;
    programmaticScrollDeadlineRef.current = 0;
    topGrowthHoldDeadlineRef.current = 0;
  }, []);

  // Every navigation (previous-message button, turn navigator, patch-key jump)
  // routes through here. The row is addressed by its semanticKey, not its
  // index: older history prepending above shifts every index but no key. A
  // row outside the virtual window has no DOM yet, so the loop first lands on
  // the virtualizer's estimated offset for it, then corrects against the real
  // DOM every frame until the row has held the top of the viewport for a few
  // frames (estimates settling into measurements, markdown/code growing
  // asynchronously, a prepend landing mid-flight) or the timeout passes.
  const scrollRowToTop = useCallback(
    (semanticKey: string, token: number) => {
      const scrollEl = tanstackScrollRef.current;
      if (!scrollEl) {
        endNavigation(token);
        return;
      }

      const deadline = performance.now() + NAVIGATION_TIMEOUT_MS;
      const selector = `[data-semantic-key="${CSS.escape(semanticKey)}"]`;
      let stableFrames = 0;

      const step = () => {
        if (navigationTokenRef.current !== token) return;
        const index = prevRowsRef.current.findIndex(
          (row) => row.semanticKey === semanticKey
        );
        if (index < 0 || performance.now() > deadline) {
          endNavigation(token);
          return;
        }
        // The loop is the only writer while it runs: no TanStack size
        // adjustment, no history-hold compensation, no scroll-up paging.
        programmaticScrollDeadlineRef.current = performance.now() + 500;
        topGrowthHoldDeadlineRef.current = 0;

        const node = scrollEl.querySelector<HTMLElement>(selector);
        if (node) {
          const delta =
            node.getBoundingClientRect().top -
            scrollEl.getBoundingClientRect().top;
          const before = scrollEl.scrollTop;
          if (Math.abs(delta) >= 1) scrollEl.scrollTop += delta;
          // Aligned, or the container cannot scroll any further.
          if (Math.abs(delta) < 1 || scrollEl.scrollTop === before) {
            stableFrames += 1;
          } else {
            stableFrames = 0;
          }
          if (stableFrames >= NAVIGATION_SETTLE_FRAMES) {
            endNavigation(token);
            return;
          }
        } else {
          stableFrames = 0;
          const block = virtualBlockRef.current;
          const offset = conversationVirtualizer.virtualizer.getOffsetForIndex(
            index,
            'start'
          )?.[0];
          if (block && offset != null) {
            const blockTop =
              scrollEl.scrollTop +
              block.getBoundingClientRect().top -
              scrollEl.getBoundingClientRect().top;
            scrollEl.scrollTop = blockTop + offset;
          }
        }
        requestAnimationFrame(step);
      };

      step();
    },
    [conversationVirtualizer, endNavigation]
  );

  // Jump to a turn by execution-process id: page in older history until the
  // process is loaded, wait for the batch to land in the rows, then scroll its
  // user message to the top.
  const scrollToProcess = useCallback(
    async (processId: string) => {
      const token = beginNavigation();
      await loadUntilProcess(processId);

      const findTarget = () => {
        const rows = prevRowsRef.current;
        const ofProcess = (row: ConversationRow) =>
          row.entry.executionProcessId === processId;
        return (
          rows.find((row) => row.isUserMessage && ofProcess(row)) ??
          rows.find(ofProcess)
        )?.semanticKey;
      };
      const deadline = performance.now() + NAVIGATION_TIMEOUT_MS;
      let targetKey = findTarget();
      while (targetKey === undefined && performance.now() < deadline) {
        await nextFrame();
        if (navigationTokenRef.current !== token) return;
        targetKey = findTarget();
      }
      if (targetKey === undefined) endNavigation(token);
      else scrollRowToTop(targetKey, token);
    },
    [beginNavigation, endNavigation, loadUntilProcess, scrollRowToTop]
  );

  // Freeze the viewport while older history streams in from the top.
  //
  // Historic batches prepend above whatever the reader is looking at, growing
  // the content upward. We add that growth back onto scrollTop so the messages
  // under the viewport stay put. A single delta rule (measure how much the
  // scrollable content grew since we last looked, add it to scrollTop) covers
  // it without needing an anchor element that virtualization might unmount.
  //
  // Only compensates while the hold is armed (historic batch arrived and the
  // reader is scrolled up). At the bottom the bottom-lock owns the position, so
  // we skip. Tracking scrollHeight in a ref shared by both callers means
  // whichever fires first for a given growth consumes the delta and the other
  // sees zero — no double compensation.
  const compensateTopGrowth = useCallback(() => {
    const scrollEl = tanstackScrollRef.current;
    if (!scrollEl) return;

    const delta = topGrowthScrollDelta(
      lastScrollHeightRef.current,
      scrollEl.scrollHeight
    );
    lastScrollHeightRef.current = scrollEl.scrollHeight;
    if (delta === 0) return;
    if (performance.now() > topGrowthHoldDeadlineRef.current) return;
    if (
      !navigationActiveRef.current &&
      isNearBottom(
        scrollEl.scrollTop,
        scrollEl.clientHeight,
        scrollEl.scrollHeight
      )
    ) {
      return;
    }

    scrollEl.scrollTop += delta;
  }, []);

  // Pre-paint pass for growth that lands synchronously with the data commit.
  useLayoutEffect(() => {
    compensateTopGrowth();
  }, [dataVersion, compensateTopGrowth]);

  // Safety net for growth that settles a frame later (TanStack Virtual total
  // size, async markdown/code/diff measurement). The ResizeObserver fires
  // whenever the content height actually changes, so no growth slips through.
  useEffect(() => {
    const content = conversationContentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;

    const scrollEl = tanstackScrollRef.current;
    lastScrollHeightRef.current = scrollEl ? scrollEl.scrollHeight : 0;

    const observer = new ResizeObserver(() => {
      compensateTopGrowth();
    });
    observer.observe(content);

    return () => observer.disconnect();
  }, [compensateTopGrowth]);

  // Scroll-up pagination: fetch the next older batch when the reader nears the
  // top, instead of eagerly streaming all history in the background. The fetch
  // is a single controlled prepend that compensateTopGrowth holds in place, so
  // the reader keeps their position and the content below never shifts on its
  // own. loadOlderHistory guards against re-entrancy, so firing on every scroll
  // event is fine; it self-throttles to one in-flight fetch.
  const NEAR_TOP_PAGINATION_PX = 600;
  useEffect(() => {
    const el = tanstackScrollRef.current;
    if (!el || !hasMoreHistory) return;

    const maybeLoadOlder = () => {
      // A navigation owns the viewport until it settles; a prepend landing
      // then would move the row it is aligning. Older turns page in on the
      // reader's next scroll instead.
      if (navigationActiveRef.current) return;
      if (el.scrollTop <= NEAR_TOP_PAGINATION_PX) {
        loadOlderHistory();
      }
    };

    el.addEventListener('scroll', maybeLoadOlder, { passive: true });
    // Fire once in case the initial view already sits near the top (short
    // conversations, or a viewport taller than the first batch).
    maybeLoadOlder();

    return () => el.removeEventListener('scroll', maybeLoadOlder);
  }, [hasMoreHistory, loadOlderHistory]);

  // Determine if there are entries to show placeholders
  const hasEntries = conversationRows.length > 0;

  // Show placeholders only if script not configured AND not already run AND first turn
  const showSetupPlaceholder =
    !hasSetupScript && !hasSetupScriptRun && hasEntries;
  const showCleanupPlaceholder =
    !hasCleanupScript &&
    !hasCleanupScriptRun &&
    !hasRunningProcess &&
    hasEntries &&
    isFirstTurn;

  // Previous-message button. Anchors on the first visible row by key, then
  // walks back to the nearest user message. When that message is not loaded
  // yet, older batches are fetched first (each prepend shifts the anchor's
  // index, never its key) and the scroll starts only once the target row
  // exists — accurate over fast.
  const scrollToPreviousUserMessage = useCallback(async () => {
    const scrollEl = tanstackScrollRef.current;
    const rows = prevRowsRef.current;
    if (!scrollEl || rows.length === 0) return;

    const token = beginNavigation();
    const anchorKey =
      findFirstVisibleRowKey(scrollEl) ?? rows[rows.length - 1].semanticKey;

    const findTarget = () => {
      const current = prevRowsRef.current;
      const anchorIndex = current.findIndex(
        (row) => row.semanticKey === anchorKey
      );
      if (anchorIndex < 0) return undefined;
      const index = findPreviousUserMessageIndex(current, anchorIndex);
      return index >= 0 ? current[index].semanticKey : null;
    };

    let targetKey = findTarget();
    while (targetKey === null) {
      const loaded = await loadOlderBatch();
      if (navigationTokenRef.current !== token) return;
      if (!loaded) break;
      // The batch reaches prevRowsRef on the rAF flush scheduled by the emit,
      // which runs before a frame requested after it.
      await nextFrame();
      targetKey = findTarget();
    }
    if (targetKey) scrollRowToTop(targetKey, token);
    else endNavigation(token);
  }, [beginNavigation, endNavigation, loadOlderBatch, scrollRowToTop]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToPreviousUserMessage: () => {
        void scrollToPreviousUserMessage();
      },
      scrollToBottom: (behavior = 'smooth') => {
        scrollToBottomAndClearSpacer(behavior);
      },
      adjustScrollBy: (delta) => {
        if (Math.abs(delta) < 0.5) return;
        const scrollElement = tanstackScrollRef.current;
        if (!scrollElement) return;
        scrollElement.scrollTop += delta;
      },
      getScrollElement: () => tanstackScrollRef.current,
      scrollToEntryByPatchKey: (patchKey: string) => {
        const row = prevRowsRef.current.find(
          (row) => row.entry.patchKey === patchKey
        );
        if (row) scrollRowToTop(row.semanticKey, beginNavigation());
      },
      scrollToProcess: (processId: string) => {
        void scrollToProcess(processId);
      },
      getVisibleUserMessagePatchKey: () => {
        const scrollEl = tanstackScrollRef.current;
        const rows = prevRowsRef.current;
        if (!scrollEl || rows.length === 0) return null;
        // Nearest user message at or before the first visible row.
        const firstKey = findFirstVisibleRowKey(scrollEl);
        let i = rows.findIndex((row) => row.semanticKey === firstKey);
        if (i < 0) i = rows.length - 1;
        for (; i >= 0; i--) {
          if (rows[i].isUserMessage) return rows[i].entry.patchKey;
        }
        return null;
      },
    }),
    [
      beginNavigation,
      scrollRowToTop,
      scrollToBottomAndClearSpacer,
      scrollToPreviousUserMessage,
      scrollToProcess,
    ]
  );

  const showLoader = loading && conversationRows.length === 0;
  const showEmptyState = !loading && conversationRows.length === 0;

  const { virtualItems, totalSize, measureElement } = conversationVirtualizer;

  useEffect(() => {
    return () => {
      clearPendingInteractionAnchor();
    };
  }, [clearPendingInteractionAnchor]);

  return (
    <ApprovalFormProvider>
      <div className="relative h-full overflow-hidden">
        {showLoader && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <SpinnerIcon className="size-6 animate-spin text-low" />
          </div>
        )}
        {/* Floats over the content: an in-flow indicator above the rows grew
            and shrank the content and shifted whatever the reader (or a
            navigation) had aligned at the top. */}
        {isLoadingHistory && !showLoader && (
          <div
            aria-live="polite"
            className="pointer-events-none absolute inset-x-0 top-base z-10 flex justify-center"
          >
            <div className="flex items-center gap-half rounded-full border border-border bg-panel/90 px-base py-half text-xs text-low shadow-sm backdrop-blur-sm">
              <SpinnerIcon className="size-3 animate-spin" />
              <span>{t('conversation.loadingEarlierMessages')}</span>
            </div>
          </div>
        )}
        <div
          ref={tanstackScrollRef}
          className="h-full overflow-y-auto scrollbar-none"
          style={{ overflowAnchor: 'none', contain: 'strict' }}
          onClickCapture={handleConversationClickCapture}
        >
          {/* Empty state lives OUTSIDE the observed content wrapper so its
              `min-h-full` vertical centering resolves against the scroll
              container's definite height. The wrapper is intentionally
              content-sized (auto height) so its ResizeObserver can detect
              tail-row growth, which would otherwise break that centering. */}
          {showEmptyState && (
            <div className="flex min-h-full items-center justify-center px-double py-12">
              <ChatEmptyState
                title={t('conversation.emptyTitle', {
                  defaultValue: 'Send a message to start the conversation.',
                })}
                description={t('conversation.emptyDescription', {
                  defaultValue:
                    'Your workspace conversation will appear here once a new turn starts.',
                })}
              />
            </div>
          )}

          <div ref={conversationContentRef}>
            <div className="pt-2">
              {showSetupPlaceholder && (
                <div className="my-base px-double">
                  <ChatScriptPlaceholder
                    type="setup"
                    onConfigure={
                      canConfigure ? handleConfigureSetup : undefined
                    }
                  />
                </div>
              )}
            </div>

            {virtualizedRows.length > 0 && (
              <div
                ref={virtualBlockRef}
                style={{
                  height: `${totalSize}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualItems.map((virtualItem) => {
                  const row = virtualizedRows[virtualItem.index];
                  if (!row) return null;
                  return (
                    <div
                      key={row.semanticKey}
                      data-index={virtualItem.index}
                      data-row-index={virtualItem.index}
                      data-semantic-key={row.semanticKey}
                      ref={measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      {renderRowContent(row.entry, attempt, resetAction, repos)}
                      {attempt.session &&
                        artifactResultRows.has(row.entry.patchKey) && (
                          <ExecutionArtifactResults
                            processId={row.entry.executionProcessId}
                            workspaceId={attempt.id}
                            sessionId={attempt.session.id}
                          />
                        )}
                    </div>
                  );
                })}
              </div>
            )}

            {unvirtualizedTailRows.map((row, tailIndex) => {
              const rowIndex = firstUnvirtualizedRowIndex + tailIndex;
              return (
                <div
                  key={row.semanticKey}
                  data-row-index={rowIndex}
                  data-semantic-key={row.semanticKey}
                >
                  {renderRowContent(row.entry, attempt, resetAction, repos)}
                  {attempt.session &&
                    artifactResultRows.has(row.entry.patchKey) && (
                      <ExecutionArtifactResults
                        processId={row.entry.executionProcessId}
                        workspaceId={attempt.id}
                        sessionId={attempt.session.id}
                      />
                    )}
                </div>
              );
            })}

            {/* Plan-reveal spacer: provides extra scroll room so plan-reveal
              can align the plan entry to the top of the viewport. Height is set
              imperatively in scrollToAbsoluteIndex and cleared on scrollToBottom. */}
            <div ref={planRevealSpacerRef} style={{ height: 0 }} />

            {/* Footer placeholder */}
            <div className="pb-2">
              {showCleanupPlaceholder && (
                <div className="my-base px-double">
                  <ChatScriptPlaceholder
                    type="cleanup"
                    onConfigure={
                      canConfigure ? handleConfigureCleanup : undefined
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </ApprovalFormProvider>
  );
});

export default ConversationList;
