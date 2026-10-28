import type { KeyboardEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { handleDrawerDetailKeyDown } from './drawerKeyboard';

function press(
  key: string,
  options: {
    editable?: boolean;
    button?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    isComposing?: boolean;
    defaultPrevented?: boolean;
    portaled?: boolean;
  } = {}
) {
  const actions = {
    backToList: vi.fn(),
    navigateNote: vi.fn(),
    focusComment: vi.fn(),
  };
  const event = {
    key,
    preventDefault: vi.fn(),
    nativeEvent: { isComposing: options.isComposing },
    currentTarget: { contains: () => !options.portaled },
    target: {
      closest: (selector: string) =>
        selector.startsWith('input') ? options.editable : options.button,
    },
    ...options,
  } as unknown as KeyboardEvent<HTMLElement>;
  handleDrawerDetailKeyDown(event, actions);
  return { ...actions, event };
}

describe('Drawer detail keyboard', () => {
  it('focuses comments with Return and returns to the list with Escape', () => {
    expect(press('Enter').focusComment).toHaveBeenCalledOnce();
    expect(press('Escape').backToList).toHaveBeenCalledOnce();
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])(
    'navigates left/right with %j',
    (modifier) => {
      expect(press('ArrowLeft', modifier).navigateNote).toHaveBeenCalledWith(
        -1
      );
      expect(press('ArrowRight', modifier).navigateNote).toHaveBeenCalledWith(
        1
      );
    }
  );

  it('leaves ordinary scrolling keys to the browser', () => {
    for (const key of [
      'ArrowUp',
      'ArrowDown',
      'PageUp',
      'PageDown',
      'Home',
      'End',
      ' ',
    ]) {
      expect(press(key).event.preventDefault).not.toHaveBeenCalled();
    }
  });

  it('preserves text editing, native activation, composition, and handled keys', () => {
    for (const key of ['Enter', 'Escape', 'ArrowLeft', 'ArrowRight']) {
      expect(
        press(key, { editable: true, metaKey: true }).event.preventDefault
      ).not.toHaveBeenCalled();
      expect(
        press(key, { isComposing: true }).event.preventDefault
      ).not.toHaveBeenCalled();
      expect(
        press(key, { defaultPrevented: true }).event.preventDefault
      ).not.toHaveBeenCalled();
    }
    expect(
      press('Enter', { button: true }).focusComment
    ).not.toHaveBeenCalled();
    for (const modifier of [
      { shiftKey: true },
      { altKey: true },
      { metaKey: true },
      { ctrlKey: true },
    ]) {
      expect(press('Enter', modifier).focusComment).not.toHaveBeenCalled();
    }
  });
  it('leaves keys in portaled dialogs and menus to their own layer', () => {
    for (const key of ['Enter', 'Escape', 'ArrowRight']) {
      expect(
        press(key, { portaled: true }).event.preventDefault
      ).not.toHaveBeenCalled();
    }
  });
});
