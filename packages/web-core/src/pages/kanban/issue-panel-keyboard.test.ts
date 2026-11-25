import { describe, expect, it, vi } from 'vitest';
import { handleIssuePanelKeyDown } from '@vibe/ui/lib/issue-panel-keyboard';

function setup({ active = true, reducedMotion = false } = {}) {
  const control = { hasAttribute: () => false, closest: () => null };
  const doc = {
    body: { ...control },
    documentElement: { ...control },
    activeElement: {} as object,
    defaultView: {
      matchMedia: () => ({ matches: reducedMotion }),
    },
  };
  const button = { ...control };
  const input = { ...control, closest: () => ({}) };
  const editor = { ...control, isContentEditable: true };
  const outside = { ...control };
  const scroller = {
    scrollHeight: 1200,
    scrollBy: vi.fn(),
    scrollTo: vi.fn(),
    focus: vi.fn(),
  };
  const pane = {
    hasAttribute: (name: string) => name === 'data-workspace-pane',
    getAttribute: () => (active ? 'true' : null),
    contains: (node: object) => node === panel,
  };
  const panel = {
    ownerDocument: doc,
    closest: () => pane,
    contains: (node: object) =>
      [scroller, input, editor, button].some((element) => element === node),
  };
  const title = { focus: vi.fn() };
  doc.activeElement = panel;

  function keyDown(key: string, modifiers: Partial<KeyboardEvent> = {}) {
    const event = Object.assign(new Event('keydown', { cancelable: true }), {
      key,
      ...modifiers,
    }) as KeyboardEvent;
    const stop = vi.spyOn(event, 'stopImmediatePropagation');
    handleIssuePanelKeyDown(
      event,
      panel as unknown as HTMLDivElement,
      scroller as unknown as HTMLDivElement,
      title as unknown as HTMLTextAreaElement
    );
    return {
      prevented: event.defaultPrevented,
      owned: stop.mock.calls.length > 0,
    };
  }

  return {
    doc,
    pane,
    scroller,
    title,
    button,
    input,
    editor,
    outside,
    keyDown,
  };
}

describe('issue panel scrolling keys', () => {
  it('scrolls on the first arrow and repeats without moving focus or the board', () => {
    const { doc, pane, scroller, keyDown } = setup();
    doc.activeElement = pane;
    expect(keyDown('ArrowDown')).toEqual({ prevented: true, owned: true });
    expect(keyDown('ArrowDown', { repeat: true })).toEqual({
      prevented: true,
      owned: true,
    });
    keyDown('ArrowUp');
    expect(scroller.scrollBy.mock.calls).toEqual([
      [{ top: 80, behavior: 'smooth' }],
      [{ top: 80, behavior: 'smooth' }],
      [{ top: -80, behavior: 'smooth' }],
    ]);
    expect(scroller.focus).not.toHaveBeenCalled();
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it('scrolls to the end or start and does not restart on key repeat', () => {
    const { doc, button, scroller, keyDown } = setup();
    doc.activeElement = button;
    expect(keyDown('ArrowDown', { metaKey: true })).toEqual({
      prevented: true,
      owned: true,
    });
    keyDown('ArrowDown', { metaKey: true, repeat: true });
    doc.activeElement = doc.body;
    keyDown('ArrowUp', { metaKey: true });
    expect(scroller.scrollTo.mock.calls).toEqual([
      [{ top: 1200, behavior: 'smooth' }],
      [{ top: 0, behavior: 'smooth' }],
    ]);
  });

  it('jumps without animation when reduced motion is preferred', () => {
    const { scroller, keyDown } = setup({ reducedMotion: true });
    keyDown('ArrowUp');
    expect(scroller.scrollBy).toHaveBeenCalledWith({
      top: -80,
      behavior: 'instant',
    });
    keyDown('ArrowDown', { metaKey: true });
    expect(scroller.scrollTo).toHaveBeenCalledWith({
      top: 1200,
      behavior: 'instant',
    });
  });

  it('leaves editing controls and other panes alone', () => {
    const { doc, input, editor, outside, scroller, keyDown } = setup();
    for (const target of [input, editor, outside]) {
      doc.activeElement = target;
      expect(keyDown('ArrowUp').owned).toBe(false);
      expect(keyDown('ArrowUp', { metaKey: true }).owned).toBe(false);
    }
    expect(scroller.scrollBy).not.toHaveBeenCalled();
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    const background = setup({ active: false });
    background.doc.activeElement = background.doc.body;
    expect(background.keyDown('ArrowDown').owned).toBe(false);
    expect(background.keyDown('ArrowDown', { metaKey: true }).owned).toBe(
      false
    );
  });

  it('still focuses the title on plain Enter after scrolling', () => {
    const { title, keyDown } = setup();
    keyDown('ArrowDown');
    expect(keyDown('Enter', { metaKey: true }).owned).toBe(false);
    expect(keyDown('Enter').prevented).toBe(true);
    expect(title.focus).toHaveBeenCalledTimes(1);
  });
});
