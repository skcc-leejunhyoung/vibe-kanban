import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
  type ReactNode,
} from 'react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { useHotkeys } from 'react-hotkeys-hook';
import { useLocation } from '@tanstack/react-router';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { cn } from '@/shared/lib/utils';
import {
  NEXT_SPLIT_PANE_BINDING_ID,
  PREVIOUS_SPLIT_PANE_BINDING_ID,
  SPLIT_PRESET_BINDING_IDS,
  resolveModifier,
} from '@/shared/keyboard/registry';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import {
  type SplitPaneState,
  type SplitPreset,
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
  event: 'activate' | 'navigate' | 'preset' | 'focus-pane' | 'move-pane';
  paneId?: string;
  sourcePaneId?: string;
  url?: string;
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

function postToParent(message: PaneMessage) {
  window.parent.postMessage(message, window.location.origin);
}

function isSplitPreset(value: unknown): value is SplitPreset {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function usePresetHotkeys(onPreset: (preset: SplitPreset) => void) {
  const overrides = useKeyboardShortcutsStore((state) => state.overrides);
  const bind = (preset: SplitPreset) =>
    resolveModifier(SPLIT_PRESET_BINDING_IDS[preset], overrides);
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

    const dragHandle = document.querySelector<HTMLElement>(
      DRAG_HANDLE_SELECTOR
    );
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
  const src = useMemo(() => {
    const url = new URL(embeddedUrl(sourceUrl), window.location.origin);
    url.searchParams.set('vk_split_pane', pane.id);
    return `${url.pathname}${url.search}${url.hash}`;
  }, [pane.id, sourceUrl]);

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

  const activatePreset = useCallback(
    (nextPreset: SplitPreset) => {
      setPreset(nextPreset, initialUrlRef.current);
    },
    [setPreset]
  );
  usePresetHotkeys(activatePreset);

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
    const handleMessage = (event: MessageEvent<PaneMessage>) => {
      if (event.origin !== window.location.origin) return;
      const message = event.data;
      if (!message || message.type !== MESSAGE_TYPE) return;
      const senderPaneId = Array.from(paneFramesRef.current.entries()).find(
        ([, frame]) => frame.contentWindow === event.source
      )?.[0];
      if (!senderPaneId) return;
      if (message.event === 'preset' && isSplitPreset(message.preset)) {
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
  }, [activatePane, activatePreset, focusAdjacentPane, movePane, setPaneUrl]);

  const renderPane = (pane: SplitPaneState) => (
    <PaneFrame
      key={pane.id}
      pane={pane}
      fallbackUrl={initialUrlRef.current}
      highlighted={highlightedPaneId === pane.id}
      frameRef={(frame) => {
        if (frame) paneFramesRef.current.set(pane.id, frame);
        else paneFramesRef.current.delete(pane.id);
      }}
      onActivate={() => activatePane(pane.id)}
      onDropPane={(sourceId) => movePane(sourceId, pane.id)}
    />
  );

  const horizontalLayout = (
    panes: SplitPaneState[],
    sizeOffset = 0
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
        className="h-full min-h-0"
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

  if (preset < 4) {
    return horizontalLayout(presetState.panes);
  }

  const rows = [presetState.panes.slice(0, 2), presetState.panes.slice(2, 4)];
  return (
    <Group
      orientation="vertical"
      defaultLayout={{
        'split-row-1': presetState.verticalSizes?.[0] ?? 50,
        'split-row-2': presetState.verticalSizes?.[1] ?? 50,
      }}
      onLayoutChange={(layout: Layout) =>
        setVerticalSizes([layout['split-row-1'], layout['split-row-2']])
      }
      className="h-full min-h-0"
    >
      <Panel id="split-row-1" minSize={20}>
        {horizontalLayout(rows[0], 0)}
      </Panel>
      <Separator className="relative z-10 h-1 shrink-0 bg-border/60 transition-colors hover:bg-brand data-[resize-handle-active]:bg-brand" />
      <Panel id="split-row-2" minSize={20}>
        {horizontalLayout(rows[1], 2)}
      </Panel>
    </Group>
  );
}
