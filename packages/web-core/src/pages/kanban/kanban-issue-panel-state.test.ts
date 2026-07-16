import { describe, expect, it } from 'vitest';
import {
  createBlankCreateFormData,
  createInitialKanbanIssuePanelFormState,
  kanbanIssuePanelFormReducer,
  selectIsCreateDraftDirty,
} from './kanban-issue-panel-state';

describe('kanban issue workspace host selection', () => {
  it('marks a changed workspace host as draft state', () => {
    const defaults = createBlankCreateFormData('todo');
    const initial = createInitialKanbanIssuePanelFormState();
    const state = kanbanIssuePanelFormReducer(initial, {
      type: 'resetForIssueChange',
      mode: 'create',
      createFormData: { ...defaults, workspaceHostId: 'host-1' },
      hasRestoredFromScratch: false,
    });

    expect(
      selectIsCreateDraftDirty({
        state,
        mode: 'create',
        createModeDefaults: defaults,
      })
    ).toBe(true);
  });
});
