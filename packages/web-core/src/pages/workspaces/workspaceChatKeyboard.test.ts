import { describe, expect, it } from 'vitest';
import {
  resolveChatSubmitKey,
  resolveUnfocusedChatKeyAction,
  shouldHandleUnfocusedChatKey,
  shouldSubmitChatFromFocus,
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
    expect(resolveUnfocusedChatKeyAction(keyEvent('Escape'))).toBeNull();
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

describe('resolveChatSubmitKey', () => {
  it('maps Cmd/Ctrl+Enter to submit and Shift to steer', () => {
    expect(resolveChatSubmitKey(keyEvent('Enter', { metaKey: true }))).toEqual({
      steer: false,
    });
    expect(resolveChatSubmitKey(keyEvent('Enter', { ctrlKey: true }))).toEqual({
      steer: false,
    });
    expect(
      resolveChatSubmitKey(keyEvent('Enter', { metaKey: true, shiftKey: true }))
    ).toEqual({ steer: true });
  });

  it('ignores plain, Alt, composing, and handled Enter', () => {
    expect(resolveChatSubmitKey(keyEvent('Enter'))).toBeNull();
    expect(
      resolveChatSubmitKey(keyEvent('Enter', { metaKey: true, altKey: true }))
    ).toBeNull();
    expect(
      resolveChatSubmitKey(
        keyEvent('Enter', { metaKey: true, isComposing: true })
      )
    ).toBeNull();
    expect(
      resolveChatSubmitKey(
        keyEvent('Enter', { metaKey: true, defaultPrevented: true })
      )
    ).toBeNull();
  });
});

describe('shouldSubmitChatFromFocus', () => {
  const control = ({
    nodeName = 'BUTTON',
    editable = false,
    inBanner = false,
  } = {}): Element =>
    ({
      nodeName,
      isContentEditable: editable,
      hasAttribute: () => false,
      matches: () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(nodeName),
      closest: () => (inBanner ? {} : null),
    }) as unknown as Element;
  const scopeOf = (...inside: Element[]): Element =>
    ({ contains: (el: Element) => inside.includes(el) }) as unknown as Element;

  it('submits with nothing focused, even without a chat scope', () => {
    expect(shouldSubmitChatFromFocus(null, null)).toBe(true);
    expect(shouldSubmitChatFromFocus(elementWith('BODY'), null)).toBe(true);
  });

  it('submits from a non-text control inside the chat', () => {
    const button = control();
    expect(shouldSubmitChatFromFocus(button, scopeOf(button))).toBe(true);
  });

  it('leaves text fields, the question banner, and the rest of the page alone', () => {
    const editor = control({ nodeName: 'DIV', editable: true });
    const input = control({ nodeName: 'INPUT' });
    const option = control({ inBanner: true });
    const scope = scopeOf(editor, input, option);
    expect(shouldSubmitChatFromFocus(editor, scope)).toBe(false);
    expect(shouldSubmitChatFromFocus(input, scope)).toBe(false);
    expect(shouldSubmitChatFromFocus(option, scope)).toBe(false);
    expect(shouldSubmitChatFromFocus(control(), scope)).toBe(false);
  });
});
