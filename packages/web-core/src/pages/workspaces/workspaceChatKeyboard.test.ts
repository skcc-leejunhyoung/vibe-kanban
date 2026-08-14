import { describe, expect, it } from 'vitest';
import {
  resolveUnfocusedChatKeyAction,
  shouldHandleUnfocusedChatKey,
} from './workspaceChatKeyboard';

const elementWith = (nodeName: string, paneShell = false): Element =>
  ({
    nodeName,
    hasAttribute: (name: string) => paneShell && name === 'data-workspace-pane',
  }) as unknown as Element;

const keyEvent = (
  key: string,
  overrides: Partial<KeyboardEvent> = {}
): KeyboardEvent =>
  ({
    key,
    defaultPrevented: false,
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  }) as KeyboardEvent;

describe('resolveUnfocusedChatKeyAction', () => {
  it('maps unmodified arrows to chat scrolling', () => {
    expect(resolveUnfocusedChatKeyAction(keyEvent('ArrowUp'))).toEqual({
      type: 'scroll',
      delta: -80,
    });
    expect(resolveUnfocusedChatKeyAction(keyEvent('ArrowDown'))).toEqual({
      type: 'scroll',
      delta: 80,
    });
  });

  it('maps Return to composer focus', () => {
    expect(resolveUnfocusedChatKeyAction(keyEvent('Enter'))).toEqual({
      type: 'focus-composer',
    });
  });

  it('ignores modified, composing, handled, and unrelated keys', () => {
    expect(
      resolveUnfocusedChatKeyAction(keyEvent('ArrowDown', { metaKey: true }))
    ).toBeNull();
    expect(
      resolveUnfocusedChatKeyAction(keyEvent('Enter', { isComposing: true }))
    ).toBeNull();
    expect(
      resolveUnfocusedChatKeyAction(
        keyEvent('Enter', { defaultPrevented: true })
      )
    ).toBeNull();
    expect(resolveUnfocusedChatKeyAction(keyEvent('Escape'))).toEqual({
      type: 'focus-workspaces',
    });
  });
});

describe('shouldHandleUnfocusedChatKey', () => {
  it('treats the document, body, and a keyboard-focused pane shell as unfocused', () => {
    expect(shouldHandleUnfocusedChatKey(null)).toBe(true);
    expect(shouldHandleUnfocusedChatKey(elementWith('BODY'))).toBe(true);
    expect(shouldHandleUnfocusedChatKey(elementWith('HTML'))).toBe(true);
    expect(shouldHandleUnfocusedChatKey(elementWith('DIV', true))).toBe(true);
  });

  it('defers to a real focused control', () => {
    expect(shouldHandleUnfocusedChatKey(elementWith('TEXTAREA'))).toBe(false);
    expect(shouldHandleUnfocusedChatKey(elementWith('BUTTON'))).toBe(false);
  });
});
