import { describe, expect, it, vi } from 'vitest';
import {
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
});
