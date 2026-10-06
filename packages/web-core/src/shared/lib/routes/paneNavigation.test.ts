import { describe, expect, it, vi } from 'vitest';
import type { AppNavigation } from '@/shared/lib/routes/appNavigation';
import type { WorkspacePaneDestination } from '@/shared/stores/useWorkspacePanesStore';
import { createPaneAppNavigation, navigateDocumentTo } from './paneNavigation';

describe('navigateDocumentTo with a pane-scoped navigation', () => {
  it('opens a notification issue in the same pane, not the document', () => {
    const base = { goToProjectIssue: vi.fn() } as unknown as AppNavigation;
    const setDestination = vi.fn<(d: WorkspacePaneDestination) => void>();
    const pane = createPaneAppNavigation(base, {
      getDestination: () => ({ kind: 'notifications' }),
      setDestination,
    });

    navigateDocumentTo(
      { kind: 'project-issue', projectId: 'p', issueId: 'i' },
      pane
    );

    expect(setDestination).toHaveBeenCalledWith({
      kind: 'project-issue',
      projectId: 'p',
      issueId: 'i',
    });
    expect(base.goToProjectIssue).not.toHaveBeenCalled();
  });
});
