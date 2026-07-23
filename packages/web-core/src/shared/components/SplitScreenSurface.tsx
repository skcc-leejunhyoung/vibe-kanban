import {
  useCallback,
  useEffect,
  useRef,
  useState,
  Fragment,
  type ReactNode,
} from 'react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { useHotkeys } from 'react-hotkeys-hook';
import { useLocation, useRouter } from '@tanstack/react-router';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { cn } from '@/shared/lib/utils';
import {
  NEXT_SPLIT_PANE_BINDING_ID,
  PREVIOUS_SPLIT_PANE_BINDING_ID,
  SPLIT_PRESET_BINDING_IDS,
  resolveModifier,
} from '@/shared/keyboard/registry';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import { useEscapeToBlur } from '@/shared/keyboard/useEscapeToBlur';
import {
  type SplitPaneState,
  type SplitPreset,
  SPLIT_PRESETS,
  getAdjacentSplitPaneId,
  getSplitScreenUserId,
  shouldRenderSplitScreenFrames,
  useSplitScreenStore,
} from '@/shared/stores/useSplitScreenStore';

const EMBED_PARAM = 'vk_split_embed';
const MESSAGE_TYPE = 'vk-split-pane';
const WINDOW_NAME_PREFIX = 'vk-split-pane:';
const DRAG_DATA_TYPE = 'text/x-vk-split-pane';
const DRAG_HANDLE_SELECTOR = '[data-split-pane-drag-handle]';
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [contenteditable="true"], [role="button"]';

export function isSplitScreenEmbed(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get(EMBED_PARAM) === '1') {
    const paneId = params.get('vk_split_pane');
    if (paneId) window.name = `${WINDOW_NAME_PREFIX}${paneId}`;
    return true;
  }
  return window.name.startsWith(WINDOW_NAME_PREFIX);
}

function getEmbeddedPaneId(): string | null {
  const queryPaneId = new URLSearchParams(window.location.search).get(
    'vk_split_pane'
  );
  if (queryPaneId) return queryPaneId;
  return window.name.startsWith(WINDOW_NAME_PREFIX)
    ? window.name.slice(WINDOW_NAME_PREFIX.length)
    : null;
}

type PaneMessage = {
  type: typeof MESSAGE_TYPE;
  event:
    | 'activate'
    | 'ready'
    | 'navigate'
    | 'preset'
    | 'focus-pane'
    | 'move-pane'
    | 'open-pane'
    | 'navigate-to'
    | 'max-panes';
  paneId?: string;
  sourcePaneId?: string;
  maxPanes?: SplitPreset;
  url?: string;
  sourceUrl?: string;
  preset?: SplitPreset;
  direction?: 'next' | 'previous';
};

function currentRelativeUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function withoutEmbedParam(value: string): string {
  const url = new URL(value, window.location.origin);
  url.searchParams.delete(EMBED_PARAM);
  url.searchParams.delete('vk_split_pane');
  return `${url.pathname}${url.search}${url.hash}`;
}

function embeddedUrl(value: string): string {
  const url = new URL(value, window.location.origin);
  url.searchParams.set(EMBED_PARAM, '1');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function sameOriginRelativeUrl(
  value: string,
  origin: string
): string | null {
  const url = new URL(value, origin);
  if (url.origin !== origin) return null;
  url.searchParams.delete(EMBED_PARAM);
  url.searchParams.delete('vk_split_pane');
  return `${url.pathname}${url.search}${url.hash}`;
}

function postToParent(message: PaneMessage) {
  window.parent.postMessage(message, window.location.origin);
}

function isSplitPreset(value: unknown): value is SplitPreset {
  return SPLIT_PRESETS.includes(value as SplitPreset);
}

export function shouldFocusReadyPane(
  pendingPaneId: string | null,
  senderPaneId: string,
  reportedPaneId: string | undefined
): boolean {
  return (
    pendingPaneId !== null &&
    pendingPaneId === senderPaneId &&
    reportedPaneId === senderPaneId
  );
}

function usePresetHotkeys(onPreset: (preset: SplitPreset) => void) {
  const overrides = useKeyboardShortcutsStore((state) => state.overrides);
  const maxPanes = useSplitScreenStore((state) => state.maxPanes);
  const bind = (preset: SplitPreset) =>
    preset <= maxPanes
      ? resolveModifier(SPLIT_PRESET_BINDING_IDS[preset], overrides)
      : '';
  const options = (keys: string) => ({
    enabled: !!keys,
    enableOnContentEditable: false,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ['global'],
  });
  const handler = (preset: SplitPreset) => (event: KeyboardEvent) => {
    event.preventDefault();
    onPreset(preset);
  };
  const one = bind(1);
  const two = bind(2);
  const three = bind(3);
  const four = bind(4);
  const five = bind(5);
  const six = bind(6);
  const seven = bind(7);
  const eight = bind(8);
  const nine = bind(9);
  useHotkeys(one || 'unidentified', handler(1), options(one), [one, onPreset]);
  useHotkeys(two || 'unidentified', handler(2), options(two), [two, onPreset]);
  useHotkeys(three || 'unidentified', handler(3), options(three), [
    three,
    onPreset,
  ]);
  useHotkeys(four || 'unidentified', handler(4), options(four), [
    four,
    onPreset,
  ]);
  useHotkeys(five || 'unidentified', handler(5), options(five), [
    five,
    onPreset,
  ]);
  useHotkeys(six || 'unidentified', handler(6), options(six), [six, onPreset]);
  useHotkeys(seven || 'unidentified', handler(7), options(seven), [
    seven,
    onPreset,
  ]);
  useHotkeys(eight || 'unidentified', handler(8), options(eight), [
    eight,
    onPreset,
  ]);
  useHotkeys(nine || 'unidentified', handler(9), options(nine), [
    nine,
    onPreset,
  ]);
}

function usePaneFocusHotkeys(
  onFocusPane: (direction: 'next' | 'previous') => void
) {
  const overrides = useKeyboardShortcutsStore((state) => state.overrides);
  const nextKeys = resolveModifier(NEXT_SPLIT_PANE_BINDING_ID, overrides);
  const previousKeys = resolveModifier(
    PREVIOUS_SPLIT_PANE_BINDING_ID,
    overrides
  );
  const options = (keys: string) => ({
    enabled: !!keys,
    enableOnContentEditable: true,
    enableOnFormTags: true,
    preventDefault: true,
    scopes: ['global'],
  });

  useHotkeys(
    nextKeys || 'unidentified',
    (event) => {
      event.preventDefault();
      onFocusPane('next');
    },
    options(nextKeys),
    [nextKeys, onFocusPane]
  );
  useHotkeys(
    previousKeys || 'unidentified',
    (event) => {
      event.preventDefault();
      onFocusPane('previous');
    },
    options(previousKeys),
    [previousKeys, onFocusPane]
  );
}

function EmbeddedPaneBridge({ children }: { children: ReactNode }) {
  const paneId = getEmbeddedPaneId();
  const location = useLocation();
  const router = useRouter();
  const setMaxPanes = useSplitScreenStore((state) => state.setMaxPanes);

  const requestPreset = useCallback((preset: SplitPreset) => {
    postToParent({ type: MESSAGE_TYPE, event: 'preset', preset });
  }, []);
  usePresetHotkeys(requestPreset);
  const requestPaneFocus = useCallback((direction: 'next' | 'previous') => {
    postToParent({ type: MESSAGE_TYPE, event: 'focus-pane', direction });
  }, []);
  usePaneFocusHotkeys(requestPaneFocus);

  useEffect(() => {
    if (!paneId) return;
    postToParent({ type: MESSAGE_TYPE, event: 'ready', paneId });
  }, [paneId]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<PaneMessage>) => {
      if (event.source !== window.parent) return;
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== MESSAGE_TYPE) return;

      if (
        event.data.event === 'max-panes' &&
        isSplitPreset(event.data.maxPanes)
      ) {
        setMaxPanes(event.data.maxPanes);
        return;
      }

      if (
        event.data.event === 'navigate-to' &&
        event.data.paneId === paneId &&
        event.data.url
      ) {
        const target = sameOriginRelativeUrl(
          event.data.url,
          window.location.origin
        );
        if (!target || target === withoutEmbedParam(currentRelativeUrl())) {
          return;
        }
        void router.navigate({ href: target });
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [paneId, router, setMaxPanes]);

  useEffect(() => {
    if (!paneId) return;

    const dragHandle =
      document.querySelector<HTMLElement>(DRAG_HANDLE_SELECTOR);
    if (!dragHandle) return;

    const handleDragStart = (event: DragEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) {
        event.preventDefault();
        return;
      }
      event.dataTransfer?.setData(DRAG_DATA_TYPE, paneId);
      event.dataTransfer?.setData('text/plain', paneId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    };

    dragHandle.draggable = true;
    dragHandle.classList.add('cursor-grab', 'active:cursor-grabbing');
    dragHandle.addEventListener('dragstart', handleDragStart);
    return () => {
      dragHandle.draggable = false;
      dragHandle.classList.remove('cursor-grab', 'active:cursor-grabbing');
      dragHandle.removeEventListener('dragstart', handleDragStart);
    };
  }, [paneId]);

  useEffect(() => {
    if (!paneId) return;

    const handleDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes(DRAG_DATA_TYPE)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }
    };
    const handleDrop = (event: DragEvent) => {
      const sourcePaneId = event.dataTransfer?.getData(DRAG_DATA_TYPE);
      if (!sourcePaneId) return;
      event.preventDefault();
      postToParent({
        type: MESSAGE_TYPE,
        event: 'move-pane',
        paneId,
        sourcePaneId,
      });
    };

    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);
    return () => {
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
    };
  }, [paneId]);

  useEffect(() => {
    if (!paneId) return;
    const activate = () =>
      postToParent({ type: MESSAGE_TYPE, event: 'activate', paneId });
    window.addEventListener('pointerdown', activate, true);
    return () => window.removeEventListener('pointerdown', activate, true);
  }, [paneId]);

  useEffect(() => {
    if (!paneId) return;
    postToParent({
      type: MESSAGE_TYPE,
      event: 'navigate',
      paneId,
      url: withoutEmbedParam(currentRelativeUrl()),
    });
  }, [location.hash, location.pathname, location.search, paneId]);

  return <>{children}</>;
}

function PaneFrame({
  pane,
  fallbackUrl,
  highlighted,
  frameRef,
  onActivate,
  onDropPane,
}: {
  pane: SplitPaneState;
  fallbackUrl: string;
  highlighted: boolean;
  frameRef: (frame: HTMLIFrameElement | null) => void;
  onActivate: () => void;
  onDropPane: (sourceId: string) => void;
}) {
  const sourceUrl = pane.url ?? fallbackUrl;
  // `pane.url` is the last URL reported by this iframe and is persisted for
  // layout restoration. Keep the mounted iframe's src fixed: feeding a SPA
  // navigation report back into src reloads the whole iframe document.
  const [src] = useState(() => {
    const url = new URL(embeddedUrl(sourceUrl), window.location.origin);
    url.searchParams.set('vk_split_pane', pane.id);
    return `${url.pathname}${url.search}${url.hash}`;
  });

  return (
    <div
      className={cn(
        'relative flex h-full min-h-0 flex-col overflow-hidden bg-primary'
      )}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const sourceId = event.dataTransfer.getData(DRAG_DATA_TYPE);
        if (sourceId) onDropPane(sourceId);
      }}
    >
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 z-20 border border-brand transition-opacity duration-500',
          highlighted ? 'opacity-100' : 'opacity-0'
        )}
      />
      <iframe
        ref={frameRef}
        title={`Split pane ${pane.id}`}
        src={src}
        allow="clipboard-read; clipboard-write"
        className="min-h-0 flex-1 border-0 bg-primary"
        onFocus={onActivate}
      />
    </div>
  );
}

const resizeHandle = (
  <Separator className="relative z-10 w-1 shrink-0 bg-border/60 transition-colors hover:bg-brand data-[resize-handle-active]:bg-brand" />
);

export function SplitScreenSurface({ children }: { children: ReactNode }) {
  useEscapeToBlur();

  if (isSplitScreenEmbed()) {
    return <EmbeddedPaneBridge>{children}</EmbeddedPaneBridge>;
  }

  return <SplitScreenManager>{children}</SplitScreenManager>;
}

function SplitScreenManager({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const activeUserId = useSplitScreenStore((state) => state.activeUserId);
  const preset = useSplitScreenStore((state) => state.preset);
  const presetState = useSplitScreenStore((state) => state.presets[preset]);
  const setPreset = useSplitScreenStore((state) => state.setPreset);
  const setMaxPanes = useSplitScreenStore((state) => state.setMaxPanes);
  const maxPanes = useSplitScreenStore((state) => state.maxPanes);
  const openPane = useSplitScreenStore((state) => state.openPane);
  const setActivePane = useSplitScreenStore((state) => state.setActivePane);
  const setPaneUrl = useSplitScreenStore((state) => state.setPaneUrl);
  const movePane = useSplitScreenStore((state) => state.movePane);
  const setHorizontalSizes = useSplitScreenStore(
    (state) => state.setHorizontalSizes
  );
  const setVerticalSizes = useSplitScreenStore(
    (state) => state.setVerticalSizes
  );
  const syncUser = useSplitScreenStore((state) => state.syncUser);
  const initialUrlRef = useRef(withoutEmbedParam(currentRelativeUrl()));
  const paneFramesRef = useRef(new Map<string, HTMLIFrameElement>());
  const readyPaneIdsRef = useRef(new Set<string>());
  const pendingFocusPaneIdRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedPaneId, setHighlightedPaneId] = useState<string | null>(
    null
  );
  const expectedUserId = getSplitScreenUserId({
    isLoaded,
    isSignedIn,
    userId,
  });

  useEffect(() => {
    if (expectedUserId === undefined) return;
    syncUser(expectedUserId);
  }, [expectedUserId, syncUser]);

  const activatePane = useCallback(
    (paneId: string, moveDomFocus = false) => {
      setActivePane(paneId);
      setHighlightedPaneId(paneId);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => {
        setHighlightedPaneId(null);
        highlightTimerRef.current = null;
      }, 700);
      if (moveDomFocus) {
        paneFramesRef.current.get(paneId)?.focus();
      }
    },
    [setActivePane]
  );

  const activatePreset = useCallback(
    (nextPreset: SplitPreset) => {
      const firstPane =
        useSplitScreenStore.getState().presets[nextPreset].panes[0];
      pendingFocusPaneIdRef.current =
        nextPreset > 1 && firstPane ? firstPane.id : null;
      setPreset(nextPreset, initialUrlRef.current);
      if (!firstPane) return;
      activatePane(firstPane.id);

      if (nextPreset <= 1) return;
      requestAnimationFrame(() => {
        if (!readyPaneIdsRef.current.has(firstPane.id)) return;
        pendingFocusPaneIdRef.current = null;
        activatePane(firstPane.id, true);
      });
    },
    [activatePane, setPreset]
  );
  usePresetHotkeys(activatePreset);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const focusAdjacentPane = useCallback(
    (direction: 'next' | 'previous') => {
      const paneId = getAdjacentSplitPaneId(
        presetState.panes,
        presetState.activePaneId,
        direction
      );
      if (paneId) activatePane(paneId, true);
    },
    [activatePane, presetState.activePaneId, presetState.panes]
  );
  usePaneFocusHotkeys(focusAdjacentPane);

  useEffect(() => {
    for (const frame of paneFramesRef.current.values()) {
      frame.contentWindow?.postMessage(
        { type: MESSAGE_TYPE, event: 'max-panes', maxPanes },
        window.location.origin
      );
    }
  }, [maxPanes]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<PaneMessage>) => {
      if (event.origin !== window.location.origin) return;
      const message = event.data;
      if (!message || message.type !== MESSAGE_TYPE) return;
      const senderPaneId = Array.from(paneFramesRef.current.entries()).find(
        ([, frame]) => frame.contentWindow === event.source
      )?.[0];
      if (!senderPaneId) return;
      if (message.event === 'ready') {
        readyPaneIdsRef.current.add(senderPaneId);
        if (
          shouldFocusReadyPane(
            pendingFocusPaneIdRef.current,
            senderPaneId,
            message.paneId
          )
        ) {
          pendingFocusPaneIdRef.current = null;
          activatePane(senderPaneId, true);
        }
      } else if (message.event === 'preset' && isSplitPreset(message.preset)) {
        activatePreset(message.preset);
      } else if (
        message.event === 'activate' &&
        message.paneId === senderPaneId
      ) {
        activatePane(message.paneId);
      } else if (
        message.event === 'focus-pane' &&
        (message.direction === 'next' || message.direction === 'previous')
      ) {
        focusAdjacentPane(message.direction);
      } else if (
        message.event === 'move-pane' &&
        message.paneId === senderPaneId &&
        message.sourcePaneId
      ) {
        movePane(message.sourcePaneId, senderPaneId);
      } else if (message.event === 'open-pane' && message.url) {
        if (
          openPane(
            message.url,
            message.sourceUrl ?? initialUrlRef.current,
            senderPaneId
          ) === 'overflow'
        ) {
          window.open(message.url, '_blank', 'noopener,noreferrer');
        } else {
          const currentState = useSplitScreenStore.getState();
          const targetPaneId =
            currentState.presets[currentState.preset].activePaneId;
          requestAnimationFrame(() => {
            const targetFrame = paneFramesRef.current.get(targetPaneId);
            targetFrame?.contentWindow?.postMessage(
              {
                type: MESSAGE_TYPE,
                event: 'navigate-to',
                paneId: targetPaneId,
                url: message.url,
              } satisfies PaneMessage,
              window.location.origin
            );
            activatePane(targetPaneId, true);
          });
        }
      } else if (
        message.event === 'max-panes' &&
        isSplitPreset(message.maxPanes)
      ) {
        setMaxPanes(message.maxPanes);
      } else if (
        message.event === 'navigate' &&
        message.paneId === senderPaneId &&
        message.url
      ) {
        setPaneUrl(message.paneId, message.url);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [
    activatePane,
    activatePreset,
    focusAdjacentPane,
    movePane,
    openPane,
    setMaxPanes,
    setPaneUrl,
  ]);

  const renderPane = (pane: SplitPaneState) => (
    <PaneFrame
      key={pane.id}
      pane={pane}
      fallbackUrl={initialUrlRef.current}
      highlighted={highlightedPaneId === pane.id}
      frameRef={(frame) => {
        if (frame) paneFramesRef.current.set(pane.id, frame);
        else {
          paneFramesRef.current.delete(pane.id);
          readyPaneIdsRef.current.delete(pane.id);
        }
      }}
      onActivate={() => activatePane(pane.id)}
      onDropPane={(sourceId) => movePane(sourceId, pane.id)}
    />
  );

  const horizontalLayout = (
    panes: SplitPaneState[],
    sizeOffset = 0,
    viewportHeight = false
  ) => {
    const slotIds = panes.map(
      (_, index) => `split-preset-${preset}-slot-${sizeOffset + index + 1}`
    );
    return (
      <Group
        orientation="horizontal"
        defaultLayout={Object.fromEntries(
          slotIds.map((id, index) => [
            id,
            presetState.horizontalSizes?.[sizeOffset + index] ??
              100 / panes.length,
          ])
        )}
        onLayoutChange={(layout: Layout) =>
          setHorizontalSizes(
            slotIds.map((id) => layout[id]),
            sizeOffset
          )
        }
        className={viewportHeight ? 'h-dvh min-h-0' : 'h-full min-h-0'}
      >
        {panes.map((pane, index) => (
          <Fragment key={slotIds[index]}>
            {index > 0 && resizeHandle}
            <Panel id={slotIds[index]} minSize={15}>
              {renderPane(pane)}
            </Panel>
          </Fragment>
        ))}
      </Group>
    );
  };

  if (activeUserId !== expectedUserId) {
    return null;
  }

  // Keep the normal single-pane application in the parent document. Rendering
  // it through an iframe disconnects parent-owned navigation (App Bar, sidebar,
  // command palette) from the visible router, so those controls appear inert.
  if (!shouldRenderSplitScreenFrames(preset)) {
    return <>{children}</>;
  }

  const rowCount = preset <= 3 ? 1 : preset <= 6 ? 2 : 3;
  if (rowCount === 1) {
    return horizontalLayout(presetState.panes, 0, true);
  }

  const baseRowSize = Math.floor(preset / rowCount);
  const largerRows = preset % rowCount;
  const rows: SplitPaneState[][] = [];
  let paneOffset = 0;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const rowSize = baseRowSize + (rowIndex < largerRows ? 1 : 0);
    rows.push(presetState.panes.slice(paneOffset, paneOffset + rowSize));
    paneOffset += rowSize;
  }
  return (
    <Group
      orientation="vertical"
      defaultLayout={Object.fromEntries(
        rows.map((_, index) => [
          `split-row-${index + 1}`,
          presetState.verticalSizes?.[index] ?? 100 / rows.length,
        ])
      )}
      onLayoutChange={(layout: Layout) =>
        setVerticalSizes(
          rows.map((_, index) => layout[`split-row-${index + 1}`])
        )
      }
      className="h-dvh min-h-0"
    >
      {rows.map((row, index) => {
        const offset = rows
          .slice(0, index)
          .reduce((total, current) => total + current.length, 0);
        return (
          <Fragment key={`split-row-${index + 1}`}>
            {index > 0 && (
              <Separator className="relative z-10 h-1 shrink-0 bg-border/60 transition-colors hover:bg-brand data-[resize-handle-active]:bg-brand" />
            )}
            <Panel id={`split-row-${index + 1}`} minSize={10}>
              {horizontalLayout(row, offset)}
            </Panel>
          </Fragment>
        );
      })}
    </Group>
  );
}
