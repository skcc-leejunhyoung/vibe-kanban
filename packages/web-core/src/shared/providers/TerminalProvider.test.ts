import { describe, expect, it } from 'vitest';
import { terminalReducer } from './TerminalProvider';

const EMPTY = { tabsByWorkspace: {}, activeTabByWorkspace: {} };

function create(state = EMPTY, workspaceId = 'ws') {
  return terminalReducer(state, { type: 'CREATE_TAB', workspaceId });
}

describe('terminalReducer', () => {
  it('keeps every session and activates the newest', () => {
    const state = create(create(create()));
    const tabs = state.tabsByWorkspace.ws;
    expect(tabs).toHaveLength(3);
    expect(new Set(tabs.map((t) => t.id)).size).toBe(3);
    expect(state.activeTabByWorkspace.ws).toBe(tabs[2].id);
  });

  it('switches between sessions', () => {
    const state = create(create());
    const first = state.tabsByWorkspace.ws[0].id;
    const switched = terminalReducer(state, {
      type: 'SET_ACTIVE_TAB',
      workspaceId: 'ws',
      tabId: first,
    });
    expect(switched.activeTabByWorkspace.ws).toBe(first);
    // A tab that is already gone must not become active.
    expect(
      terminalReducer(switched, {
        type: 'SET_ACTIVE_TAB',
        workspaceId: 'ws',
        tabId: 'term-gone',
      })
    ).toBe(switched);
  });

  it('closing the active session falls back to a neighbour', () => {
    const state = create(create(create()));
    const [, second, third] = state.tabsByWorkspace.ws;
    const closed = terminalReducer(state, {
      type: 'CLOSE_TAB',
      workspaceId: 'ws',
      tabId: third.id,
    });
    expect(closed.tabsByWorkspace.ws).toHaveLength(2);
    expect(closed.activeTabByWorkspace.ws).toBe(second.id);
  });

  it('scopes sessions per workspace and drops them all on clear', () => {
    const state = create(create(EMPTY, 'other'));
    expect(state.tabsByWorkspace.other).toHaveLength(1);
    expect(state.tabsByWorkspace.ws).toHaveLength(1);

    const cleared = terminalReducer(state, {
      type: 'CLEAR_WORKSPACE_TABS',
      workspaceId: 'ws',
    });
    expect(cleared.tabsByWorkspace.ws).toBeUndefined();
    expect(cleared.tabsByWorkspace.other).toHaveLength(1);
  });
});
