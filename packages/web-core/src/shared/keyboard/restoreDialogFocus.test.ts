import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreDialogFocus } from '@vibe/ui/lib/dialog-keyboard';

// Focus scopes restore on a `setTimeout(0)`, so the next dialog in an
// `await ConfirmDialog.show()` chain has already mounted and focused itself by
// the time the closing one restores. The web-core test env is `node` with no
// DOM, so stub the two things the helper reads — matching useEscapeToClose.test.
const body = { tagName: 'BODY' };

function stubDocument(activeElement: unknown) {
  vi.stubGlobal('document', { activeElement, body });
}

function opener(isConnected = true) {
  return {
    isConnected,
    focus: vi.fn(),
  } as unknown as HTMLElement;
}

function inDialog() {
  return { closest: (sel: string) => (sel === '[role="dialog"]' ? {} : null) };
}

afterEach(() => vi.unstubAllGlobals());

describe('restoreDialogFocus', () => {
  it('returns focus to the opener when nothing else claimed it', () => {
    stubDocument(body);
    const el = opener();
    restoreDialogFocus(el);
    expect(el.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('declines when focus already moved into another dialog', () => {
    stubDocument(inDialog());
    const el = opener();
    restoreDialogFocus(el);
    expect(el.focus).not.toHaveBeenCalled();
  });

  it('declines when the opener was unmounted, and tolerates none', () => {
    stubDocument(body);
    const el = opener(false);
    restoreDialogFocus(el);
    expect(el.focus).not.toHaveBeenCalled();
    expect(() => restoreDialogFocus(null)).not.toThrow();
  });
});
