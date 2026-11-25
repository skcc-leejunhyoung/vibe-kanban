import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { ARTIFACT_CSP, isolatePreviewDocument } from './isolatedPreview';

function preview(interactive = true, svg = false) {
  const nodes: { tag: string; textContent: string }[] = [];
  const doc = {
    createElement: (tag: string) => ({
      tag,
      textContent: '',
      setAttribute() {},
    }),
    head: {
      prepend: (node: (typeof nodes)[number]) => nodes.unshift(node),
      append: (node: (typeof nodes)[number]) => nodes.push(node),
    },
    documentElement: {
      get outerHTML() {
        return `<html><head>${nodes.map((node) => `<${node.tag}>${node.textContent}</${node.tag}>`).join('')}</head><body></body></html>`;
      },
    },
  };
  const html = isolatePreviewDocument(
    doc as unknown as Document,
    svg,
    interactive
      ? {
          channel: 'test-channel',
          initial: { status: 'input_required', message: '', editable: true },
        }
      : undefined
  );
  return {
    html,
    resize: nodes.find((node) =>
      node.textContent.includes('new ResizeObserver')
    )?.textContent,
  };
}

describe('interactive artifact layout', () => {
  it('keeps both sandboxes and the network policy while disabling document scrolling only for inputs', () => {
    const { html, resize } = preview();
    expect(html).toContain(ARTIFACT_CSP);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('scrolling="no"');
    expect(html).toContain('html,body{overflow:clip}');
    expect(html).toContain('height:auto!important');
    expect(resize).toBeDefined();
    for (const ordinary of [preview(false), preview(true, true)]) {
      expect(ordinary.resize).toBeUndefined();
      expect(ordinary.html).not.toContain('scrolling="no"');
      expect(ordinary.html).not.toContain('height:auto!important');
    }
  });

  it('measures growth, shrinkage and overflow without using the viewport-height floor or flooding updates', () => {
    const callbacks = new Map<string, () => void>();
    let measure: () => void;
    let frame: (() => void) | undefined;
    let height = 180;
    let overflow = 140;
    const setProperty = vi.fn();
    const root = {
      getBoundingClientRect: () => ({ height }),
      scrollHeight: 900,
      style: { setProperty },
    };
    const body = {
      getBoundingClientRect: () => ({ top: 20 }),
      get scrollHeight() {
        return overflow;
      },
    };
    const postMessage = vi.fn();
    let rootBackground = 'rgba(0, 0, 0, 0)';
    let bodyBackground = 'rgb(14, 22, 37)';
    runInNewContext(preview().resize!, {
      document: { documentElement: root, body },
      addEventListener: (name: string, callback: () => void) =>
        callbacks.set(name, callback),
      requestAnimationFrame: (callback: () => void) => {
        frame = callback;
      },
      getComputedStyle: (element: unknown) => ({
        marginBottom: '20px',
        backgroundColor: element === root ? rootBackground : bodyBackground,
      }),
      ResizeObserver: class {
        constructor(callback: () => void) {
          measure = callback;
        }
        observe() {}
      },
      MutationObserver: class {
        observe() {}
      },
      parent: { postMessage },
    });
    const flush = () => {
      const callback = frame;
      frame = undefined;
      callback?.();
    };
    callbacks.get('DOMContentLoaded')!();
    flush();
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: 'vibe:artifact:resize',
        height: 180,
        background: 'rgb(14, 22, 37)',
      },
      '*'
    );
    rootBackground = 'rgb(255, 255, 255)';
    measure!();
    flush();
    expect(postMessage.mock.lastCall?.[0].background).toBe(
      'rgb(255, 255, 255)'
    );
    rootBackground = 'rgba(0, 0, 0, 0)';
    bodyBackground = 'rgba(0, 0, 0, 0)';
    measure!();
    flush();
    expect(postMessage.mock.lastCall?.[0].background).toBe('rgba(0, 0, 0, 0)');
    bodyBackground = 'rgb(14, 22, 37)';
    measure!();
    flush();
    expect(postMessage).toHaveBeenCalledTimes(4);
    postMessage.mockClear();
    height = 820;
    overflow = 780;
    measure!();
    measure!();
    flush();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.lastCall?.[0].height).toBe(820);
    height = 100;
    overflow = 60;
    measure!();
    flush();
    expect(postMessage.mock.lastCall?.[0].height).toBe(100);
    overflow = 180;
    callbacks.get('load')!();
    flush();
    expect(postMessage.mock.lastCall?.[0].height).toBe(220);
    callbacks.get('resize')!();
    flush();
    expect(postMessage).toHaveBeenCalledTimes(3);
    height = 11200;
    overflow = 11160;
    measure!();
    flush();
    expect(setProperty).toHaveBeenLastCalledWith(
      'overflow-y',
      'auto',
      'important'
    );
    height = 180;
    overflow = 140;
    measure!();
    flush();
    expect(setProperty).toHaveBeenLastCalledWith(
      'overflow-y',
      'clip',
      'important'
    );
  });

  it('relays bounded resize messages from the inner frame only', () => {
    const html = preview().html;
    const relay = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
    let listener: (event: unknown) => void;
    const inner = {};
    const postMessage = vi.fn();
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    runInNewContext(relay, {
      addEventListener: (_: string, callback: typeof listener) => {
        listener = callback;
      },
      document: {
        querySelector: () => ({ contentWindow: inner }),
        documentElement: { style },
      },
      parent: { postMessage },
    });
    for (const value of [NaN, Infinity, '100']) {
      listener!({
        source: inner,
        data: { type: 'vibe:artifact:resize', height: value },
      });
    }
    listener!({
      source: {},
      data: { type: 'vibe:artifact:resize', height: 900 },
    });
    expect(postMessage).not.toHaveBeenCalled();
    for (const [input, output] of [
      [-10, 0],
      [300, 300],
      [100000, 10000],
    ]) {
      listener!({
        source: inner,
        data: { type: 'vibe:artifact:resize', height: input },
      });
      expect(postMessage).toHaveBeenLastCalledWith(
        { type: 'vibe:artifact:resize', height: output },
        '*'
      );
    }
  });

  it('paints the wrapper with the opaque inner canvas so a short inner frame leaves no white edge', () => {
    const relay = preview().html.match(
      /<script nonce="[^"]+">([\s\S]*?)<\/script>/
    )![1];
    let listener: (event: unknown) => void;
    const inner = {};
    const postMessage = vi.fn();
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    runInNewContext(relay, {
      addEventListener: (_: string, callback: typeof listener) => {
        listener = callback;
      },
      document: {
        querySelector: () => ({ contentWindow: inner }),
        documentElement: { style },
      },
      parent: { postMessage },
    });
    const resize = (background: unknown) =>
      listener!({
        source: inner,
        data: { type: 'vibe:artifact:resize', height: 120, background },
      });
    resize('rgb(14, 22, 37)');
    expect(style.setProperty).toHaveBeenLastCalledWith(
      '--canvas',
      'rgb(14, 22, 37)'
    );
    expect(postMessage).toHaveBeenLastCalledWith(
      { type: 'vibe:artifact:resize', height: 120 },
      '*'
    );
    for (const background of [
      'rgba(0, 0, 0, 0)',
      'rgba(14, 22, 37, 0.5)',
      'red; color: blue',
      undefined,
    ]) {
      style.removeProperty.mockClear();
      resize(background);
      expect(style.removeProperty).toHaveBeenCalledExactlyOnceWith('--canvas');
    }
    expect(style.setProperty).toHaveBeenCalledOnce();
    expect(preview().html).toContain('background:var(--canvas,white)');
  });

  it('relays only bounded focus positions from the interactive inner frame', () => {
    const relay = preview().html.match(
      /<script nonce="[^"]+">([\s\S]*?)<\/script>/
    )![1];
    let listener: (event: unknown) => void;
    const inner = {};
    const postMessage = vi.fn();
    runInNewContext(relay, {
      addEventListener: (_: string, callback: typeof listener) => {
        listener = callback;
      },
      document: { querySelector: () => ({ contentWindow: inner }) },
      parent: { postMessage },
    });
    for (const [top, bottom] of [
      [-1, 20],
      [50, 20],
      [0, 10001],
      [NaN, 20],
      [0, Infinity],
    ]) {
      listener!({
        source: inner,
        data: { type: 'vibe:artifact:focus', top, bottom },
      });
    }
    const data = { type: 'vibe:artifact:focus', top: 400, bottom: 440 };
    listener!({ source: {}, data });
    expect(postMessage).not.toHaveBeenCalled();
    listener!({ source: inner, data });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(data, '*');
  });
});
