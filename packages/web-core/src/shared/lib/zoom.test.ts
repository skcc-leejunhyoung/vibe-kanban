import { afterEach, describe, expect, it, vi } from 'vitest';

// zoom.ts caches the current level in module state, so each case loads a fresh
// copy against stubbed storage/DOM globals.
async function loadZoom(stored?: string, storedTextScale?: string) {
  const store = new Map<string, string>();
  if (stored) store.set('vk-zoom-level', stored);
  if (storedTextScale) store.set('vk-text-scale', storedTextScale);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const style: Record<string, string> = {};
  vi.stubGlobal('document', {
    documentElement: {
      style: Object.assign(style, {
        setProperty: (k: string, v: string) => void (style[k] = v),
        removeProperty: (k: string) => void delete style[k],
      }),
    },
  });
  vi.stubGlobal('window', new EventTarget());
  vi.resetModules();
  const zoom = await import('./zoom');
  return { zoom, store, style };
}

afterEach(() => vi.unstubAllGlobals());

describe('app zoom', () => {
  it('steps in integer font sizes and clamps at both ends', async () => {
    const { zoom, style } = await loadZoom();
    expect(zoom.getZoomPercent()).toBe(100);

    zoom.zoomIn();
    expect(style.fontSize).toBe('17px');

    for (let i = 0; i < 50; i++) zoom.zoomIn();
    expect(zoom.getZoomPercent()).toBe(zoom.MAX_ZOOM_PERCENT);
    expect(style.fontSize).toBe('32px');

    for (let i = 0; i < 50; i++) zoom.zoomOut();
    expect(zoom.getZoomPercent()).toBe(zoom.MIN_ZOOM_PERCENT);
    expect(style.fontSize).toBe('8px');
  });

  it('persists a zoomed level and clears storage on reset', async () => {
    const { zoom, store } = await loadZoom();
    zoom.zoomIn();
    expect(store.get('vk-zoom-level')).toBe('17');
    zoom.zoomReset();
    expect(store.has('vk-zoom-level')).toBe(false);
    expect(zoom.getZoomPercent()).toBe(zoom.DEFAULT_ZOOM_PERCENT);
  });

  it('rounds a fractional stored level back onto the integer steps', async () => {
    const { zoom, style } = await loadZoom('18.5');
    expect(style.fontSize).toBe(undefined);
    expect(zoom.getZoomPercent()).toBe(119);
    zoom.zoomIn();
    expect(style.fontSize).toBe('20px');
  });

  it('restores the stored level and notifies subscribers on change', async () => {
    const { zoom } = await loadZoom('20');
    expect(zoom.getZoomPercent()).toBe(125);

    const onChange = vi.fn();
    const unsubscribe = zoom.subscribeZoom(onChange);
    zoom.zoomOut();
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    zoom.zoomOut();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('zooms text and UI together and resets both', async () => {
    const { zoom, store, style } = await loadZoom();
    zoom.textSizeIn();
    zoom.zoomIn();
    expect(style.fontSize).toBe('17px');
    expect(zoom.getZoomPercent()).toBe(106);
    expect(zoom.getTextPercent()).toBe(117);

    zoom.zoomReset();
    expect(zoom.getZoomPercent()).toBe(100);
    expect(zoom.getTextPercent()).toBe(100);
    expect(style['--vk-text-scale']).toBe(undefined);
    expect(store.has('vk-text-scale')).toBe(false);
  });
});

describe('text and UI size', () => {
  it('scales text without moving the root font size', async () => {
    const { zoom, store, style } = await loadZoom();
    zoom.textSizeIn();
    expect(style.fontSize).toBe('16px');
    expect(style['--vk-text-scale']).toBe('1.1');
    expect(zoom.getTextPercent()).toBe(110);
    expect(zoom.getZoomPercent()).toBe(100);
    expect(store.get('vk-text-scale')).toBe('1.1');

    zoom.textSizeReset();
    expect(style['--vk-text-scale']).toBe(undefined);
    expect(store.has('vk-text-scale')).toBe(false);
  });

  it('steps the UI while holding the rendered text size', async () => {
    const { zoom, style } = await loadZoom();
    zoom.uiSizeIn();
    expect(style.fontSize).toBe('17px');
    expect(zoom.getZoomPercent()).toBe(106);
    expect(zoom.getTextPercent()).toBe(100);
    expect(style['--vk-text-scale']).toBe('0.9412');

    zoom.textSizeIn();
    expect(zoom.getTextPercent()).toBe(110);
    expect(zoom.getZoomPercent()).toBe(106);

    zoom.uiSizeReset();
    expect(style.fontSize).toBe('16px');
    expect(zoom.getTextPercent()).toBe(110);
    expect(style['--vk-text-scale']).toBe('1.1');
  });

  it('restores a stored scale and clamps the text size', async () => {
    const { zoom } = await loadZoom('20', '1.2');
    expect(zoom.getTextPercent()).toBe(150);

    for (let i = 0; i < 20; i++) zoom.textSizeIn();
    expect(zoom.getTextPercent()).toBe(zoom.MAX_TEXT_PERCENT);
    for (let i = 0; i < 40; i++) zoom.textSizeOut();
    expect(zoom.getTextPercent()).toBe(zoom.MIN_TEXT_PERCENT);
    expect(zoom.getZoomPercent()).toBe(125);
  });

  it('ignores a stored scale the steppers could never produce', async () => {
    // The reachable range is 0.25 (50% text at 32px) to 4 (200% at 8px).
    expect((await loadZoom(undefined, '4')).zoom.getTextScale()).toBe(4);
    expect((await loadZoom(undefined, '0.25')).zoom.getTextScale()).toBe(0.25);
    for (const garbage of ['50', '0.1', '-2', 'abc']) {
      const { zoom } = await loadZoom(undefined, garbage);
      expect(zoom.getTextScale()).toBe(1);
    }
  });
});
