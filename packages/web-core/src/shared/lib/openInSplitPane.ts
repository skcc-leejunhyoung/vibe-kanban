import {
  type SplitPreset,
  useSplitScreenStore,
} from '@/shared/stores/useSplitScreenStore';

const MESSAGE_TYPE = 'vk-split-pane';
const EMBED_PARAM = 'vk_split_embed';
const WINDOW_NAME_PREFIX = 'vk-split-pane:';

function isEmbeddedPane(): boolean {
  return (
    new URLSearchParams(window.location.search).get(EMBED_PARAM) === '1' ||
    window.name.startsWith(WINDOW_NAME_PREFIX)
  );
}

function currentRelativeUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function openInSplitPane(url: string): void {
  if (isEmbeddedPane()) {
    window.parent.postMessage(
      {
        type: MESSAGE_TYPE,
        event: 'open-pane',
        url,
        sourceUrl: currentRelativeUrl(),
      },
      window.location.origin
    );
    return;
  }

  const result = useSplitScreenStore
    .getState()
    .openPane(url, currentRelativeUrl());
  if (result === 'overflow') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function activateSplitPreset(preset: SplitPreset): void {
  if (isEmbeddedPane()) {
    window.parent.postMessage(
      { type: MESSAGE_TYPE, event: 'preset', preset },
      window.location.origin
    );
    return;
  }
  useSplitScreenStore.getState().setPreset(preset, currentRelativeUrl());
}

export function updateMaxSplitPanes(maxPanes: SplitPreset): void {
  useSplitScreenStore.getState().setMaxPanes(maxPanes);
  if (isEmbeddedPane()) {
    window.parent.postMessage(
      { type: MESSAGE_TYPE, event: 'max-panes', maxPanes },
      window.location.origin
    );
  }
}
