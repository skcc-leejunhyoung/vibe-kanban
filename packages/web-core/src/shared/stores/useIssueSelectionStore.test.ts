import { beforeEach, describe, expect, it } from 'vitest';
import { useIssueSelectionStore } from './useIssueSelectionStore';

describe('useIssueSelectionStore', () => {
  beforeEach(() => {
    useIssueSelectionStore.getState().clearSelection();
    useIssueSelectionStore.getState().setOrderedIssueIds([]);
  });

  it('clears cursor and anchor when the focused issue is no longer visible', () => {
    const store = useIssueSelectionStore.getState();
    store.setOrderedIssueIds(['visible-issue', 'filtered-issue']);
    store.focusCursor('filtered-issue');

    store.setOrderedIssueIds(['visible-issue']);

    expect(useIssueSelectionStore.getState()).toMatchObject({
      orderedIssueIds: ['visible-issue'],
      cursorIssueId: null,
      anchorIssueId: null,
    });
  });

  it('keeps cursor and anchor while the focused issue remains visible', () => {
    const store = useIssueSelectionStore.getState();
    store.setOrderedIssueIds(['focused-issue']);
    store.focusCursor('focused-issue');

    store.setOrderedIssueIds(['focused-issue', 'another-issue']);

    expect(useIssueSelectionStore.getState()).toMatchObject({
      cursorIssueId: 'focused-issue',
      anchorIssueId: 'focused-issue',
    });
  });
});
