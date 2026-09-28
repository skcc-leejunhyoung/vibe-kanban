import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isLayeredAbove,
  keepDialogFocusOnLayerClose,
  restoreDialogFocus,
} from '@vibe/ui/lib/dialog-keyboard';

// The web-core test env is `node` with no DOM: stub only what each helper
// reads, matching restoreDialogFocus.test.
const body = { tagName: 'BODY' };

function inDialog() {
  return { closest: (sel: string) => (sel === '[role="dialog"]' ? {} : null) };
}

function closeEvent() {
  return {
    defaultPrevented: false,
    preventDefault: vi.fn(),
  } as unknown as Event;
}

afterEach(() => vi.unstubAllGlobals());

describe('keepDialogFocusOnLayerClose', () => {
  const dialog = (contains = false) => ({
    closest: () => null,
    contains: () => contains,
  });
  const focusIn = (dlg: unknown) => ({
    closest: (sel: string) => (sel === '[role="dialog"]' ? dlg : null),
  });
  const layer = (attrs: Record<string, string>) => ({
    id: attrs.id ?? '',
    getAttribute: (name: string) => attrs[name] ?? null,
  });
  const closeEvent = (currentTarget: unknown) =>
    ({
      currentTarget,
      defaultPrevented: false,
      preventDefault: vi.fn(),
    }) as unknown as Event;

  it('lets the layer refocus its trigger when no dialog took focus', () => {
    vi.stubGlobal('document', { activeElement: body, body });
    const event = closeEvent(layer({ role: 'menu' }));
    const onCloseAutoFocus = vi.fn();
    keepDialogFocusOnLayerClose(event, onCloseAutoFocus);
    expect(onCloseAutoFocus).toHaveBeenCalledWith(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps focus in the dialog a menu item opened, and hands the dialog the menu trigger to restore to', () => {
    // Radix only sets the trigger's aria-controls while open; the menu content
    // is labelled by its trigger.
    const trigger = { isConnected: true, focus: vi.fn() };
    const dlg = dialog();
    vi.stubGlobal('document', {
      activeElement: focusIn(dlg),
      body,
      getElementById: (id: string) => (id === 'trigger' ? trigger : null),
    });
    const event = closeEvent(
      layer({ role: 'menu', 'aria-labelledby': 'trigger' })
    );
    keepDialogFocusOnLayerClose(event);
    expect(event.preventDefault).toHaveBeenCalled();

    // The dialog closes: its own opener (the menu item) is gone with the menu.
    vi.stubGlobal('document', { activeElement: body, body });
    restoreDialogFocus(null, dlg as unknown as Element);
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('finds a select or popover trigger through aria-controls', () => {
    const trigger = { isConnected: true, focus: vi.fn() };
    const dlg = dialog();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
    vi.stubGlobal('document', {
      activeElement: focusIn(dlg),
      body,
      querySelector: (sel: string) =>
        sel === '[aria-controls="radix-:r1:"]' ? trigger : null,
    });
    keepDialogFocusOnLayerClose(
      closeEvent(layer({ role: 'listbox', id: 'radix-:r1:' }))
    );
    vi.stubGlobal('document', { activeElement: body, body });
    restoreDialogFocus(null, dlg as unknown as Element);
    expect(trigger.focus).toHaveBeenCalled();
  });

  it('ignores a menu that lives inside the dialog itself', () => {
    const trigger = { isConnected: true, focus: vi.fn() };
    const dlg = dialog(true);
    vi.stubGlobal('document', {
      activeElement: focusIn(dlg),
      body,
      getElementById: () => trigger,
    });
    keepDialogFocusOnLayerClose(
      closeEvent(layer({ role: 'menu', 'aria-labelledby': 'trigger' }))
    );
    vi.stubGlobal('document', { activeElement: body, body });
    restoreDialogFocus(null, dlg as unknown as Element);
    expect(trigger.focus).not.toHaveBeenCalled();
  });
});

describe('isLayeredAbove', () => {
  // <body> holds #root (app), then portal roots in open order.
  type Node = { parentElement: Node | null; order: number };
  const bodyNode = { parentElement: null, order: 0 } as unknown as Node;
  const root = (order: number) => ({
    parentElement: bodyNode,
    order,
    compareDocumentPosition(other: Node) {
      return other.order > order ? 4 : 2; // FOLLOWING : PRECEDING
    },
  });
  const child = (parent: Node) => ({ parentElement: parent, order: -1 });

  it('treats later portals as above and the app tree as behind', () => {
    vi.stubGlobal('document', { body: bodyNode });
    const app = root(1);
    const dialog = root(2);
    const menu = root(3);
    const container = child(dialog) as unknown as Element;
    expect(isLayeredAbove(container, child(menu) as unknown as Element)).toBe(
      true
    );
    expect(isLayeredAbove(container, child(app) as unknown as Element)).toBe(
      false
    );
    expect(isLayeredAbove(container, child(dialog) as unknown as Element)).toBe(
      true
    );
  });
});
