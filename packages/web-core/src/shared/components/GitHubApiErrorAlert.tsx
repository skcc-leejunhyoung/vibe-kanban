import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OAuthDialog } from '@/shared/dialogs/global/OAuthDialog';
import { isGitHubAuthenticationError } from '@/shared/lib/remoteApi';

/** Preserve the server's auth/permission/rate-limit errors at every PR entry point. */
export function GitHubApiErrorAlert({
  error,
  fallback,
  className = 'text-sm text-error',
}: {
  error: unknown;
  fallback: string;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const reconnect = useMutation({
    mutationFn: async () => {
      const authenticated = await OAuthDialog.show({
        initialProvider: 'github',
        reauthenticate: true,
      });
      if (!authenticated) return;
      await queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === 'github-repositories' ||
          queryKey[0] === 'pull-request-summaries' ||
          ((queryKey[0] === 'pr-detail' || queryKey[0] === 'pr-info') &&
            queryKey[2] === 'github') ||
          (queryKey[0] === 'prComments' &&
            queryKey[1] === 'url' &&
            queryKey[4] === 'github'),
      });
    },
  });
  if (!error) return null;

  return (
    <div role="alert" className={className}>
      <span>{error instanceof Error ? error.message : fallback}</span>
      {isGitHubAuthenticationError(error) && (
        <button
          type="button"
          className="ml-base underline"
          disabled={reconnect.isPending}
          onClick={() => reconnect.mutate()}
        >
          Reconnect GitHub
        </button>
      )}
      {reconnect.isError && <p>{reconnect.error.message}</p>}
    </div>
  );
}
