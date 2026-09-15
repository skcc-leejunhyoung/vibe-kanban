import { describe, expect, it, vi } from 'vitest';
import {
  hasPointerBlockingLayerBelow,
  isModalKeyboardActive,
  isTopModalKeyboardLayer,
  registerModalKeyboardLayer,
} from '@vibe/ui/lib/modal-keyboard';

describe('modal keyboard layers', () => {
  it('keeps background scopes disabled until the last modal closes', () => {
    const enableScope = vi.fn();
    const disableScope = vi.fn();
    const controls = {
      activeScopes: ['global', 'workspace', 'kanban', 'projects'],
      enableScope,
      disableScope,
    };
    const outer = Symbol('outer');
    const inner = Symbol('inner');

    const closeOuter = registerModalKeyboardLayer(outer, controls);
    expect(disableScope.mock.calls.map(([scope]) => scope)).toEqual(
      controls.activeScopes
    );
    expect(enableScope).toHaveBeenCalledWith('dialog');
    expect(isModalKeyboardActive()).toBe(true);
    expect(isTopModalKeyboardLayer(outer)).toBe(true);

    enableScope.mockClear();
    disableScope.mockClear();
    const closeInner = registerModalKeyboardLayer(inner, controls);
    expect(enableScope).not.toHaveBeenCalled();
    expect(disableScope).not.toHaveBeenCalled();
    expect(isTopModalKeyboardLayer(inner)).toBe(true);

    closeOuter();
    expect(isModalKeyboardActive()).toBe(true);
    expect(enableScope).not.toHaveBeenCalled();
    expect(disableScope).not.toHaveBeenCalled();

    closeInner();
    expect(isModalKeyboardActive()).toBe(false);
    expect(disableScope).toHaveBeenCalledWith('dialog');
    expect(enableScope.mock.calls.map(([scope]) => scope)).toEqual(
      controls.activeScopes
    );
  });

  it('reports a pointer-blocking (Radix modal) layer only when it sits below', () => {
    const controls = {
      activeScopes: [],
      enableScope: vi.fn(),
      disableScope: vi.fn(),
    };
    const radix = Symbol('radix');
    const keyboard = Symbol('keyboard');
    const unregistered = Symbol('unregistered');

    const closeRadix = registerModalKeyboardLayer(radix, controls, {
      blocksOutsidePointer: true,
    });
    // Not registered yet (first open render) — everything open is below it.
    expect(hasPointerBlockingLayerBelow(unregistered)).toBe(true);
    const closeKeyboard = registerModalKeyboardLayer(keyboard, controls);
    expect(hasPointerBlockingLayerBelow(keyboard)).toBe(true);
    expect(hasPointerBlockingLayerBelow(radix)).toBe(false);

    closeRadix();
    closeKeyboard();
    expect(hasPointerBlockingLayerBelow(unregistered)).toBe(false);
  });
});
