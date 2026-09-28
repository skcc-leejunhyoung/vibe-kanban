import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorConfig } from 'shared/types';
import { useSessionMessageEditor } from './useSessionMessageEditor';

const saves: Array<{ id: string; message: string }> = [];

vi.mock('@/shared/hooks/useScratch', () => ({
  useScratch: (_type: string, id: string) => ({
    scratch: null,
    isLoading: false,
    updateScratch: async (update: {
      payload: { data: { message: string } };
    }) => {
      saves.push({ id, message: update.payload.data.message });
    },
    deleteScratch: async () => {},
  }),
}));

const config = { executor: 'CLAUDE_CODE' } as ExecutorConfig;
let root: Root;
let editor: ReturnType<typeof useSessionMessageEditor>;

function Probe({ scratchId }: { scratchId: string }) {
  editor = useSessionMessageEditor({ scratchId });
  return null;
}

beforeEach(() => {
  saves.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), { nodeType: 9, activeElement: null })
  );
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      document,
      setTimeout,
      clearTimeout,
      HTMLIFrameElement: class {},
    })
  );
  const container = Object.assign(new EventTarget(), {
    nodeType: 1,
    tagName: 'DIV',
    ownerDocument: document,
  });
  root = createRoot(container as unknown as HTMLElement);
  act(() => root.render(<Probe scratchId="session-a" />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSessionMessageEditor pending draft', () => {
  it('saves on pagehide instead of waiting out the debounce', () => {
    act(() => editor.handleMessageChange('typed then reloaded', config));
    expect(saves).toEqual([]);

    window.dispatchEvent(new Event('pagehide'));

    expect(saves).toEqual([
      { id: 'session-a', message: 'typed then reloaded' },
    ]);
  });

  it('saves into the scratch it was typed into when the scratch switches', () => {
    act(() => editor.handleMessageChange('draft for a', config));
    act(() => root.render(<Probe scratchId="session-b" />));
    act(() => vi.runAllTimers());

    expect(saves).toEqual([{ id: 'session-a', message: 'draft for a' }]);
  });

  it('does not resurrect a draft whose save was cancelled', () => {
    act(() => editor.handleMessageChange('sent', config));
    act(() => editor.cancelDebouncedSave());
    act(() => root.unmount());
    root = createRoot(
      Object.assign(new EventTarget(), {
        nodeType: 1,
        tagName: 'DIV',
        ownerDocument: document,
      }) as unknown as HTMLElement
    );

    expect(saves).toEqual([]);
  });
});
