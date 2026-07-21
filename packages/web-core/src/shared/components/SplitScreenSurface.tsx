import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  Fragment,
  type ReactNode,
} from 'react';
import { ArrowsOutIcon, DotsSixVerticalIcon } from '@phosphor-icons/react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { useHotkeys } from 'react-hotkeys-hook';
import { useLocation } from '@tanstack/react-router';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { cn } from '@/shared/lib/utils';
import {
  SPLIT_PRESET_BINDING_IDS,
  resolveModifier,
} from '@/shared/keyboard/registry';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import {
  type SplitPaneState,
  type SplitPreset,
  useSplitScreenStore,
} from '@/shared/stores/useSplitScreenStore';

const EMBED_PARAM = 'vk_split_embed';
const MESSAGE_TYPE = 'vk-split-pane';
const WINDOW_NAME_PREFIX = 'vk-split-pane:';

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
  event: 'activate' | 'navigate' | 'preset';
  paneId?: string;
  url?: string;
  preset?: SplitPreset;
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

function EmbeddedPaneBridge({ children }: { children: ReactNode }) {
  const paneId = getEmbeddedPaneId();
  const location = useLocation();

  const requestPreset = useCallback((preset: SplitPreset) => {
    postToParent({ type: MESSAGE_TYPE, event: 'preset', preset });
  }, []);
  usePresetHotkeys(requestPreset);

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
  active,
  showHeader,
  onActivate,
  onDropPane,
}: {
  pane: SplitPaneState;
  fallbackUrl: string;
  active: boolean;
  showHeader: boolean;
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
        'flex h-full min-h-0 flex-col overflow-hidden bg-primary',
        active && 'ring-2 ring-inset ring-brand'
      )}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const sourceId = event.dataTransfer.getData('text/x-vk-split-pane');
        if (sourceId) onDropPane(sourceId);
      }}
    >
      {showHeader && (
        <div
          className="flex h-7 shrink-0 items-center gap-1 border-b border-border bg-secondary px-1.5 text-xs text-low"
          onPointerDown={onActivate}
        >
          <button
            type="button"
            draggable
            aria-label="Move split pane"
            className="cursor-grab p-0.5 active:cursor-grabbing"
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/x-vk-split-pane', pane.id);
            }}
          >
            <DotsSixVerticalIcon className="size-3.5" weight="bold" />
          </button>
          <span className="min-w-0 flex-1 truncate">{sourceUrl}</span>
          <button
            type="button"
            aria-label="Open pane in this window"
            className="p-0.5 hover:text-normal"
            onClick={() => window.location.assign(sourceUrl)}
          >
            <ArrowsOutIcon className="size-3.5" />
          </button>
        </div>
      )}
      <iframe
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

  return <SplitScreenManager />;
}

function SplitScreenManager() {
  const { isSignedIn, userId } = useAuth();
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
  const expectedUserId = isSignedIn ? userId : null;

  useEffect(() => {
    syncUser(expectedUserId);
  }, [expectedUserId, syncUser]);

  const activatePreset = useCallback(
    (nextPreset: SplitPreset) => {
      setPreset(nextPreset, initialUrlRef.current);
    },
    [setPreset]
  );
  usePresetHotkeys(activatePreset);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<PaneMessage>) => {
      if (event.origin !== window.location.origin) return;
      const message = event.data;
      if (!message || message.type !== MESSAGE_TYPE) return;
      if (message.event === 'preset' && isSplitPreset(message.preset)) {
        activatePreset(message.preset);
      } else if (message.event === 'activate' && message.paneId) {
        setActivePane(message.paneId);
      } else if (
        message.event === 'navigate' &&
        message.paneId &&
        message.url
      ) {
        setPaneUrl(message.paneId, message.url);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [activatePreset, setActivePane, setPaneUrl]);

  const renderPane = (pane: SplitPaneState) => (
    <PaneFrame
      key={pane.id}
      pane={pane}
      fallbackUrl={initialUrlRef.current}
      active={presetState.activePaneId === pane.id}
      showHeader={preset > 1}
      onActivate={() => setActivePane(pane.id)}
      onDropPane={(sourceId) => movePane(sourceId, pane.id)}
    />
  );

  const horizontalLayout = (
    panes: SplitPaneState[],
    ids: string[],
    sizeOffset = 0
  ) => (
    <Group
      orientation="horizontal"
      defaultLayout={Object.fromEntries(
        ids.map((id, index) => [
          id,
          presetState.horizontalSizes?.[sizeOffset + index] ?? 100 / ids.length,
        ])
      )}
      onLayoutChange={(layout: Layout) =>
        setHorizontalSizes(
          ids.map((id) => layout[id]),
          sizeOffset
        )
      }
      className="h-full min-h-0"
    >
      {panes.map((pane, index) => (
        <Fragment key={pane.id}>
          {index > 0 && resizeHandle}
          <Panel id={ids[index]} minSize={15}>
            {renderPane(pane)}
          </Panel>
        </Fragment>
      ))}
    </Group>
  );

  if (activeUserId !== expectedUserId) {
    return null;
  }

  if (preset < 4) {
    const ids = presetState.panes.map((pane) => pane.id);
    return horizontalLayout(presetState.panes, ids);
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
        {horizontalLayout(
          rows[0],
          rows[0].map((pane) => pane.id),
          0
        )}
      </Panel>
      <Separator className="relative z-10 h-1 shrink-0 bg-border/60 transition-colors hover:bg-brand data-[resize-handle-active]:bg-brand" />
      <Panel id="split-row-2" minSize={20}>
        {horizontalLayout(
          rows[1],
          rows[1].map((pane) => pane.id),
          2
        )}
      </Panel>
    </Group>
  );
}
