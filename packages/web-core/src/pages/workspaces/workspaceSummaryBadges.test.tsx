import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSummary } from '@vibe/ui/components/WorkspaceSummary';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('WorkspaceSummary link badges', () => {
  it('shows PR and GitHub issue badges in compact summary rows', () => {
    const html = renderToStaticMarkup(
      <WorkspaceSummary
        summary
        name="Workspace"
        prStatus="open"
        prNumber={42}
        prUrl="https://github.com/acme/repo/pull/42"
        githubIssues={[
          {
            id: 'issue-77',
            number: 77,
            repository: 'acme/repo',
            url: 'https://github.com/acme/repo/issues/77',
          },
        ]}
      />
    );

    expect(html).toContain('#42');
    expect(html).toContain('#77');
  });
});
