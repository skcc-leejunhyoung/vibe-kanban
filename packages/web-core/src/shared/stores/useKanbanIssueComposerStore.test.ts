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
