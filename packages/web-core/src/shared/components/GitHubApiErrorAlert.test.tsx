import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthDialog } from '@/shared/dialogs/global/OAuthDialog';
import { RemoteApiError } from '@/shared/lib/remoteApi';
import { GitHubApiErrorAlert } from './GitHubApiErrorAlert';

const action = vi.hoisted(() => ({
  reconnect: undefined as undefined | (() => Promise<void>),
}));
vi.mock('@/shared/dialogs/global/OAuthDialog', () => ({
  OAuthDialog: { show: vi.fn() },
}));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...original,
    useMutation: (options: { mutationFn: () => Promise<void> }) => {
      action.reconnect = options.mutationFn;
      return original.useMutation(options);
    },
  };
});

function render(error: unknown, client = new QueryClient()) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GitHubApiErrorAlert
        error={error}
        fallback="Could not load pull request"
      />
    </QueryClientProvider>
  );
}

describe('GitHubApiErrorAlert', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [424, 'github_auth_required', 'GitHub authentication is required'],
    [403, 'github_forbidden', 'GitHub denied access to this resource'],
    [429, 'github_rate_limited', 'GitHub API rate limit exceeded'],
    [502, 'github_upstream_error', 'GitHub API request failed'],
    [
      400,
      'invalid_github_request',
      'invalid GitHub pull request or repository',
    ],
  ] as const)(
    'preserves the %i error and offers reconnect only for auth',
    (status, code, message) => {
      const html = render(new RemoteApiError(message, status, code));
      expect(html).toContain('role="alert"');
      expect(html).toContain(message);
      expect(html.includes('Reconnect GitHub')).toBe(status === 424);
    }
  );

  it('refreshes GitHub reads after reconnect without touching host caches or replaying writes', async () => {
    const client = new QueryClient();
    const githubKeys = [
      ['github-repositories'],
      ['pull-request-summaries', 'acme/repo', false],
      ['pr-detail', 'url', 'github'],
      ['pr-info', 'url', 'github'],
      ['prComments', 'url', 'url', 42, 'github'],
    ];
    const hostKeys = [
      ['pr-detail', 'url', 'host-a'],
      ['prComments', 'workspace', 'id', 'repo', 42, 'host-a'],
    ];
    for (const key of [...githubKeys, ...hostKeys])
      client.setQueryData(key, {});
    render(
      new RemoteApiError('Reconnect', 424, 'github_auth_required'),
      client
    );
    vi.mocked(OAuthDialog.show).mockResolvedValue(true);

    await action.reconnect!();

    expect(OAuthDialog.show).toHaveBeenCalledWith({
      initialProvider: 'github',
      reauthenticate: true,
    });
    for (const key of githubKeys)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    for (const key of hostKeys)
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    client.clear();
  });

  it('does not refetch when reconnect is cancelled', async () => {
    const client = new QueryClient();
    client.setQueryData(['github-repositories'], []);
    render(
      new RemoteApiError('Reconnect', 424, 'github_auth_required'),
      client
    );
    vi.mocked(OAuthDialog.show).mockResolvedValue(null);
    await action.reconnect!();
    expect(client.getQueryState(['github-repositories'])?.isInvalidated).toBe(
      false
    );
    client.clear();
  });
});
