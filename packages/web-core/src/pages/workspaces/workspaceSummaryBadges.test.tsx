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
        pullRequests={[
          {
            status: 'open',
            number: 42,
            url: 'https://github.com/acme/repo/pull/42',
          },
          {
            status: 'merged',
            number: 43,
            url: 'https://github.com/acme/repo/pull/43',
          },
        ]}
        githubIssues={[
          {
            id: 'issue-77',
            number: 77,
            repository: 'acme/repo',
            url: 'https://github.com/acme/repo/issues/77',
          },
          {
            id: 'issue-78',
            number: 78,
            repository: 'acme/repo',
            url: 'https://github.com/acme/repo/issues/78',
          },
        ]}
      />
    );

    expect(html).toContain('#42');
    expect(html).toContain('#43');
    expect(html).toContain('#77');
    expect(html).toContain('#78');
  });
});
