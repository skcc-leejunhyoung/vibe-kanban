import { afterEach, describe, expect, it, vi } from 'vitest';

// zoom.ts caches the current level in module state, so each case loads a fresh
// copy against stubbed storage/DOM globals.
async function loadZoom(stored?: string) {
  const store = new Map<string, string>();
  if (stored) store.set('vk-zoom-level', stored);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const style: Record<string, string> = {};
  vi.stubGlobal('document', { documentElement: { style } });
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
});
