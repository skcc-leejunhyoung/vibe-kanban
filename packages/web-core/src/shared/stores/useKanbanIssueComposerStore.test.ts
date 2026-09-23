import { beforeEach, describe, expect, it } from 'vitest';
import { useKanbanIssueComposerStore } from './useKanbanIssueComposerStore';

describe('kanban issue composer workspace host', () => {
  beforeEach(() => {
    useKanbanIssueComposerStore.setState({ byKey: {} });
  });

  it('preserves an explicitly selected local host', () => {
    const store = useKanbanIssueComposerStore.getState();
    store.openComposer('host-1:project-1');
    store.patchComposer('host-1:project-1', {
      createDraftWorkspace: true,
      workspaceHostId: null,
    });

    expect(
      useKanbanIssueComposerStore.getState().byKey['host-1:project-1']?.draft
        .workspaceHostId
    ).toBeNull();
  });
});

describe('kanban issue composer create options', () => {
  beforeEach(() => {
    useKanbanIssueComposerStore.setState({ byKey: {} });
  });

  it('seeds draft tags from the create options and restores them on reset', () => {
    const store = useKanbanIssueComposerStore.getState();
    store.openComposer('host-1:project-1', { tagIds: ['tag-a'] });
    store.patchComposer('host-1:project-1', { tagIds: [] });
    store.resetComposer('host-1:project-1');

    expect(
      useKanbanIssueComposerStore.getState().byKey['host-1:project-1']?.draft
        .tagIds
    ).toEqual(['tag-a']);
  });
});
