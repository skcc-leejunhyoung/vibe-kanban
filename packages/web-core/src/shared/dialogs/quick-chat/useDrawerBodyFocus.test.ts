import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { useDrawerBodyFocus } from './useDrawerBodyFocus';

const layers = vi.hoisted(() => ({ modal: false, above: false }));
vi.mock('@vibe/ui/lib/modal-keyboard', () => ({
  isModalKeyboardActive: () => layers.modal,
}));
vi.mock('@vibe/ui/lib/dialog-keyboard', () => ({
  isLayeredAbove: () => layers.above,
}));

type Options = Parameters<typeof useDrawerBodyFocus>[1];
const defaults: Options = {
  noteId: 'a',
  enabled: true,
  narrow: false,
  focusRequest: 0,
};
let dom: ReturnType<typeof installDomlessReact>;
let body: HTMLDivElement;
let bodyRef: { current: HTMLDivElement };
let dialog: Element | null;
let pane: EventTarget | null;
let focused: Element | null;
const insideDetail = new Set<Element>();
const insideBoard = new Set<Element>();
const focus = vi.fn();

function element(pane = false): Element {
  return {
    hasAttribute: (name: string) => pane && name === 'data-workspace-pane',
  } as unknown as Element;
}

function Probe(options: Options) {
  useDrawerBodyFocus(bodyRef, options);
  return null;
}
async function render(options: Partial<Options> = {}) {
  await dom.render(createElement(Probe, { ...defaults, ...options }));
}

beforeEach(() => {
  dom = installDomlessReact();
  insideDetail.clear();
  insideBoard.clear();
  focus.mockClear();
  layers.modal = false;
  layers.above = false;
  dialog = null;
  pane = null;
  const detail = {
    contains: (node: Element) => insideDetail.has(node),
    parentElement: { contains: (node: Element) => insideBoard.has(node) },
  };
  body = {
    scrollTop: 0,
    hasAttribute: () => false,
    closest: (selector: string) =>
      selector === '[role="dialog"]'
        ? dialog
        : selector === '[data-workspace-pane]'
          ? pane
          : detail,
    focus: (options: FocusOptions) => {
      focused = body;
      focus(options);
    },
  } as unknown as HTMLDivElement;
  bodyRef = { current: body };
  insideDetail.add(body);
  insideBoard.add(body);
  const root = element();
  Object.assign(document, { body: root, documentElement: element() });
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: () => focused,
  });
  focused = root;
});

afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

describe('Drawer body focus transitions', () => {
  it('re-enters the same note on activation without resetting its scroll', async () => {
    await render();
    expect(focused).toBe(body);
    body.scrollTop = 600;
    focused = element();
    await render({ focusRequest: 1 });
    expect(focused).toBe(body);
    expect(body.scrollTop).toBe(600);
  });

  it('starts a different note at the top', async () => {
    await render();
    body.scrollTop = 600;
    await render({ noteId: 'b', focusRequest: 1 });
    expect(focused).toBe(body);
    expect(body.scrollTop).toBe(0);
  });

  it('keeps the reader position when the pane becomes active again', async () => {
    await render();
    body.scrollTop = 600;
    await render({ enabled: false });
    focused = element(true);
    await render();
    expect(focused).toBe(body);
    expect(body.scrollTop).toBe(600);
  });

  it('does not steal focus from the comment box or a list row on pane activation', async () => {
    await render();
    for (const inDetail of [true, false]) {
      await render({ enabled: false });
      const control = element();
      insideBoard.add(control);
      if (inDetail) insideDetail.add(control);
      focused = control;
      body.scrollTop = 600;
      focus.mockClear();
      await render();
      expect(focused).toBe(control);
      expect(focus).not.toHaveBeenCalled();
      expect(body.scrollTop).toBe(600);
    }
  });

  it.each([false, true])(
    'recovers focus when a narrow layout hides the list (blurred: %s)',
    async (blurred) => {
      await render();
      const row = element();
      insideBoard.add(row);
      focused = blurred ? document.body : row;
      body.scrollTop = 400;
      await render({ narrow: true });
      expect(focused).toBe(body);
      expect(body.scrollTop).toBe(400);
    }
  );

  it('keeps comment focus when the layout narrows', async () => {
    await render();
    const editor = element();
    insideDetail.add(editor);
    insideBoard.add(editor);
    focused = editor;
    await render({ narrow: true });
    expect(focused).toBe(editor);
  });

  it('does not focus an inactive pane or a page behind a dialog', async () => {
    await render({ enabled: false });
    expect(focus).not.toHaveBeenCalled();
    layers.modal = true;
    await render();
    expect(focus).not.toHaveBeenCalled();
  });

  it('leaves a layer above the Drawer dialog focused', async () => {
    layers.modal = true;
    layers.above = true;
    dialog = { contains: () => false } as unknown as Element;
    focused = element();
    const overlay = focused;
    await render();
    expect(focus).not.toHaveBeenCalled();
    expect(focused).toBe(overlay);
  });

  it('hands pane-shell focus to the body after pane activation effects', async () => {
    pane = new EventTarget();
    await render();
    body.scrollTop = 600;
    focused = element(true);
    pane.dispatchEvent(new Event('focus'));
    expect(focused).toBe(body);
    expect(body.scrollTop).toBe(600);
    layers.modal = true;
    const shell = element(true);
    focused = shell;
    pane.dispatchEvent(new Event('focus'));
    expect(focused).toBe(shell);
  });

  it('removes the pane-shell focus listener while inactive', async () => {
    pane = new EventTarget();
    await render();
    await render({ enabled: false });
    focus.mockClear();
    pane.dispatchEvent(new Event('focus'));
    expect(focus).not.toHaveBeenCalled();
  });
});
