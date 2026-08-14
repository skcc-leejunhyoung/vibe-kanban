import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  useHotkeys,
  type Keys,
  type Options,
  type HotkeyCallback,
} from 'react-hotkeys-hook';

import { Scope } from './registry';
import { useEscapeToClose } from './useEscapeToClose';
import { useIsActivePane } from '@/shared/components/workspace-panes/PaneActiveContext';

// useEscapeToClose's whole job is to wire react-hotkeys-hook correctly: bind
// Escape in the KANBAN scope, stay active while a form field / contentEditable
// holds focus (these panels autofocus a chat editor), yield when another handler
// already claimed the key, and otherwise close. Mock useHotkeys so we can assert
// exactly those wiring choices and drive the callback directly — the web-core
// test env is `node` with no DOM to dispatch real key events into, matching the
// approach in registry.test.ts.
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: vi.fn(),
}));

// Only the active pane's copy may fire; every pane mounts this hook. Mock the
// context accessor so we can drive active/inactive without rendering a tree
// (matches the node-env, no-DOM approach used for react-hotkeys-hook above).
vi.mock('@/shared/components/workspace-panes/PaneActiveContext', () => ({
  useIsActivePane: vi.fn(() => true),
}));

const mockedUseHotkeys = vi.mocked(useHotkeys);
const mockedUseIsActivePane = vi.mocked(useIsActivePane);

// The node env has no KeyboardEvent constructor; the handler only reads
// `defaultPrevented` and calls `preventDefault`, so a plain object is enough.
function escEvent(defaultPrevented = false): KeyboardEvent {
  return {
    defaultPrevented,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

// The (keys, callback, options) react-hotkeys-hook was wired with on the most
// recent useEscapeToClose call. useHotkeys is overloaded, so the recorded args
// come back as a union; we always call it in the (keys, cb, options, deps) form,
// so the positions are fixed and the casts are safe.
function lastBinding(): {
  keys: Keys;
  callback: HotkeyCallback;
  options: Options | undefined;
} {
  const call = mockedUseHotkeys.mock.calls.at(-1);
  if (!call) throw new Error('useHotkeys was never called');
  return {
    keys: call[0] as Keys,
    callback: call[1] as HotkeyCallback,
    options: call[2] as Options | undefined,
  };
}

beforeEach(() => {
  mockedUseHotkeys.mockClear();
  mockedUseIsActivePane.mockReturnValue(true);
});

describe('useEscapeToClose', () => {
  it('binds Escape in the KANBAN scope', () => {
    useEscapeToClose(() => {});

    const { keys, options } = lastBinding();
    expect(keys).toBe('escape');
    expect(options?.scopes).toEqual([Scope.KANBAN]);
  });

  it('uses an explicitly supplied scope', () => {
    useEscapeToClose(() => {}, { scope: Scope.WORKSPACE });

    expect(lastBinding().options?.scopes).toEqual([Scope.WORKSPACE]);
  });

  it('stays active over form tags and contentEditable (panels autofocus a chat editor)', () => {
    useEscapeToClose(() => {});

    const { options } = lastBinding();
    expect(options?.enableOnFormTags).toBe(true);
    expect(options?.enableOnContentEditable).toBe(true);
  });

  it('is enabled by default and forwards an explicit enabled flag', () => {
    useEscapeToClose(() => {});
    expect(lastBinding().options?.enabled).toBe(true);

    useEscapeToClose(() => {}, { enabled: false });
    expect(lastBinding().options?.enabled).toBe(false);
  });

  it('disables itself in an inactive pane so only the active pane closes', () => {
    mockedUseIsActivePane.mockReturnValue(false);

    // Even with the caller-side enabled flag on, an inactive pane stays inert.
    useEscapeToClose(() => {}, { enabled: true });
    expect(lastBinding().options?.enabled).toBe(false);
  });

  it('closes on Escape and prevents default so later Escape handlers yield', () => {
    const onClose = vi.fn();
    useEscapeToClose(onClose);

    const e = escEvent(false);
    lastBinding().callback(e, {} as never);

    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('yields when another handler already handled Escape (defaultPrevented)', () => {
    const onClose = vi.fn();
    useEscapeToClose(onClose);

    const e = escEvent(true);
    lastBinding().callback(e, {} as never);

    // Already handled (e.g. the issue panel blurred a field and stopped
    // propagation, or an in-editor popup dismissed) — must not close or
    // re-prevent.
    expect(onClose).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
