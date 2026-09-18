import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacesSidebar } from '@vibe/ui/components/WorkspacesSidebar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const archivedPage = Array.from({ length: 50 }, (_, i) => ({
  id: `archived-${i}`,
  name: `Archived ${i}`,
}));

function render(totalArchivedCount?: number) {
  return renderToStaticMarkup(
    <WorkspacesSidebar
      workspaces={[]}
      totalWorkspacesCount={0}
      archivedWorkspaces={archivedPage}
      totalArchivedCount={totalArchivedCount}
      selectedWorkspaceId={null}
      onSelectWorkspace={() => {}}
      searchQuery=""
      onSearchChange={() => {}}
    />
  );
}

describe('WorkspacesSidebar archive count badge', () => {
  it('counts the whole archive, not the loaded page', () => {
    expect(render(1066)).toContain('>1066<');
    // Without the total, it can only count what was handed to it.
    expect(render()).toContain('>50<');
  });
});
