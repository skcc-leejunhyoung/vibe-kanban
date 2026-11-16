import { beforeEach, describe, expect, it } from 'vitest';
import { inspectModeScope, useInspectModeStore } from './useInspectModeStore';

const store = () => useInspectModeStore.getState();

beforeEach(() => {
  useInspectModeStore.setState({ inspectScope: null, pendingComponent: null });
});

describe('inspect mode scope', () => {
  it('tells the same workspace id on two hosts apart', () => {
    expect(inspectModeScope(null, 'workspace')).not.toBe(
      inspectModeScope('host-b', 'workspace')
    );
    expect(inspectModeScope('host-b', 'one')).not.toBe(
      inspectModeScope('host-b', 'two')
    );
  });

  it('puts one preview in inspect mode, not every open pane', () => {
    const here = inspectModeScope(null, 'workspace');
    const onB = inspectModeScope('host-b', 'workspace');
    store().toggleInspectMode(here);
    expect(store().inspectScope).toBe(here);
    expect(store().inspectScope).not.toBe(onB);
  });

  it('hands a picked component to the composer of its own workspace only', () => {
    const here = inspectModeScope(null, 'workspace');
    store().toggleInspectMode(here);
    store().setPendingComponentMarkdown(here, 'picked');
    // Composers paste only when the pending scope is theirs.
    expect(store().pendingComponent).toEqual({
      scope: here,
      markdown: 'picked',
    });
    expect(store().pendingComponent?.scope).not.toBe(
      inspectModeScope('host-b', 'workspace')
    );
    expect(store().inspectScope).toBeNull();
  });
});
