import { createRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@vibe/ui/components/KeyboardDialog';
import { installFakeDomReact } from '@/shared/lib/electric/electricTestKit';

vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: ReactNode) => children,
}));
vi.mock('@vibe/ui/components/DialogFocusScope', () => ({
  DialogFocusScope: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@vibe/ui/lib/modal-keyboard', () => ({
  useModalKeyboardLayer: () => ({
    isTopLayer: () => true,
    isOverPointerBlockingLayer: () => false,
  }),
}));

let dom: ReturnType<typeof installFakeDomReact>;
let dialog: HTMLDivElement;
const send = vi.fn();

beforeEach(async () => {
  dom = installFakeDomReact();
  send.mockClear();
  const ref = createRef<HTMLDivElement>();
  await dom.render(<Dialog open ref={ref} />);
  dialog = ref.current!;
  const primary = {
    disabled: false,
    click: send,
  } as unknown as HTMLButtonElement;
  dialog.querySelectorAll = vi.fn().mockReturnValue([primary]);
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    value: dialog,
  });
});

afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

function press(overrides: Record<string, unknown> = {}) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(
    event,
    Object.fromEntries(
      Object.entries({
        key: 'Enter',
        code: 'Enter',
        target: dialog,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        isComposing: false,
        repeat: false,
        ...overrides,
      }).map(([name, value]) => [name, { value }])
    )
  );
  document.dispatchEvent(event);
  return event;
}

describe('chat dialog keyboard submission', () => {
  it('leaves plain Enter alone when only the dialog has focus', () => {
    expect(press().defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['metaKey', 'ctrlKey'])('submits once with %s+Enter', (modifier) => {
    expect(press({ [modifier]: true }).defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it('leaves portaled menu events alone even after focus returns to the dialog', () => {
    const menu = { tagName: 'DIV' };
    expect(press({ target: menu }).defaultPrevented).toBe(false);
    expect(press({ target: menu, metaKey: true }).defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores composition, repeat, and extra modifiers', () => {
    for (const extra of [
      { isComposing: true },
      { repeat: true },
      { altKey: true },
      { shiftKey: true },
    ]) {
      expect(press({ metaKey: true, ...extra }).defaultPrevented).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
  });
});
